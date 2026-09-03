"""VoiceBridge 本地离线中文语音交互服务入口。

接口：
- POST /api/chat   对话接口（前端聊天页使用）：语音→文本→LLM→文本→语音
- POST /api/asr    上传录音（multipart, 字段 file），返回 {"text": "..."}
- POST /api/tts    提交 {"text": "..."}，返回 audio/wav（16kHz/mono/PCM16）
- GET  /api/health 服务状态（模型加载情况、ffmpeg、LLM 配置）
- GET  /           前端 H5 对话页（frontend/ 静态托管）

所有错误统一为 {"detail": {"code": "...", "message": "面向用户的信息"}}。
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import shutil
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from asr import ASRService
from audio_utils import probe_audio, transcode_to_16k_mono_wav
from chat import chat_service
from config import (
    ASR_ENABLED,
    MAX_RECORD_SECONDS,
    MAX_TTS_CHARS,
    MAX_UPLOAD_MB,
    REALTIME_IN_RATE,
    REALTIME_MODEL,
    REALTIME_OUT_RATE,
    VOICE_API_BASE_URL,
    VOICE_API_KEY,
)
from realtime import realtime_proxy
from tts import TTSService

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("voicebridge")

MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024

asr_service = ASRService() if ASR_ENABLED else None
tts_service = TTSService()


@asynccontextmanager
async def lifespan(_: FastAPI):
    # 模型加载耗时较长，放后台线程，接口立即可用
    if asr_service is not None:
        threading.Thread(target=asr_service.ensure_loaded, name="asr-load", daemon=True).start()
    threading.Thread(target=tts_service.ensure_loaded, name="tts-load", daemon=True).start()
    yield


app = FastAPI(title="VoiceBridge", version="1.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _remove_file(path: Path) -> None:
    path.unlink(missing_ok=True)


def _err(code: str, message: str, status_code: int) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


@app.get("/api/health")
async def health():
    asr_state = asr_service.status() if asr_service is not None else {"enabled": False, "loaded": False}
    tts_state = tts_service.status()
    ffmpeg_ok = shutil.which("ffmpeg") is not None

    if asr_state.get("loaded") and tts_state.get("loaded") and ffmpeg_ok:
        status = "ok"
    elif (asr_state.get("enabled", True) and not asr_state.get("loaded")
          and asr_state.get("error") is None) or (
        not tts_state.get("loaded") and tts_state.get("error") is None
    ):
        status = "loading"  # 仍在后台加载中
    else:
        status = "degraded"

    return {
        "status": status,
        "asr": asr_state,
        "tts": tts_state,
        "chat": {"llm_configured": chat_service.configured, "model": chat_service.model},
        "realtime": {
            "enabled": bool(VOICE_API_BASE_URL and VOICE_API_KEY),
            "model": REALTIME_MODEL,
            "in_rate": REALTIME_IN_RATE,
            "out_rate": REALTIME_OUT_RATE,
        },
        "ffmpeg": ffmpeg_ok,
        "limits": {
            "max_upload_mb": MAX_UPLOAD_MB,
            "max_record_seconds": MAX_RECORD_SECONDS,
            "max_tts_chars": MAX_TTS_CHARS,
        },
    }


@app.websocket("/ws/realtime")
async def ws_realtime(browser_ws: WebSocket):
    """实时通话代理：浏览器事件/音频 ↔ 上游 Realtime WS（key 由服务端代持）。"""
    await realtime_proxy(browser_ws)


async def _transcribe_upload(file: UploadFile) -> tuple[str, float]:
    """读取上传音频 → ffmpeg 转 16k wav → 时长校验 → FunASR 识别。返回 (文本, 时长秒)。"""
    # 流式读取，边读边限量，避免超大文件进内存
    data = bytearray()
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > MAX_UPLOAD_BYTES:
            raise _err("FILE_TOO_LARGE", f"上传文件超过 {MAX_UPLOAD_MB}MB 限制", 413)

    if not data:
        raise _err("EMPTY_FILE", "上传内容为空", 400)

    if asr_service is None:
        raise _err("ASR_DISABLED", "语音识别未启用（ASR_ENABLED=0）", 503)

    model = await asyncio.to_thread(asr_service.ensure_loaded)
    if model is None:
        raise _err("ASR_LOAD_FAILED",
                   f"语音识别模型不可用：{asr_service.status().get('error')}", 503)

    # 不信任扩展名：写入磁盘后由 ffmpeg 探测真实格式再转码
    suffix = Path(file.filename or "audio.bin").suffix.lstrip(".").lower() or "bin"
    try:
        with transcode_to_16k_mono_wav(bytes(data), suffix) as wav_path:
            info = probe_audio(wav_path)
            if info is None:
                raise _err("UNSUPPORTED_FORMAT", "无法解析音频，请确认录音文件有效", 400)
            if info.duration <= 0.05:
                raise _err("AUDIO_TOO_SHORT", "录音时间过短（<0.1 秒）", 400)
            if info.duration > MAX_RECORD_SECONDS + 1.0:
                raise _err("AUDIO_TOO_LONG",
                           f"录音时长 {info.duration:.1f}s 超过 {MAX_RECORD_SECONDS:.0f}s 限制", 413)
            text = await asyncio.to_thread(asr_service.transcribe, wav_path)
            return text, info.duration
    except RuntimeError as exc:
        # 推理阶段的模型错误（OOM 等），与加载失败区分开
        raise _err("ASR_ERROR", f"识别失败：{exc}", 503)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("ASR 请求处理失败")
        raise _err("INTERNAL_ERROR", f"服务器内部错误：{exc}", 500)


@app.post("/api/asr")
async def api_asr(file: UploadFile = File(...)):
    text, _ = await _transcribe_upload(file)
    return {"text": text}


def _sanitize_history(raw: str) -> list[dict]:
    """history 为 JSON 数组字符串 [{role, content}]，只保留最近 12 条合法轮次。"""
    try:
        items = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return []
    if not isinstance(items, list):
        return []
    turns = []
    for item in items:
        if not isinstance(item, dict):
            continue
        role, content = item.get("role"), item.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            turns.append({"role": role, "content": content.strip()[:2000]})
    return turns[-12:]


@app.post("/api/chat")
async def api_chat(
    file: UploadFile | None = File(None),
    text: str = Form(""),
    history: str = Form("[]"),
):
    """统一对话接口：语音（file）或文本（text）→ ASR → LLM → TTS。

    返回 JSON：{user_text, reply_text, audio(base64 wav), tts_engine, ...}
    """
    user_seconds = 0.0
    if file is not None and (file.filename or "").strip():
        user_text, user_seconds = await _transcribe_upload(file)
    else:
        user_text = (text or "").strip()

    if not user_text:
        raise _err("EMPTY_INPUT", "没有识别到语音内容，也未收到文字输入", 400)

    turns = _sanitize_history(history)

    try:
        reply_text = await asyncio.to_thread(chat_service.ask, user_text, turns)
    except Exception as exc:  # noqa: BLE001 - chat 抛出的都是面向用户的信息
        logger.warning("LLM 调用失败：%s", exc)
        raise _err("LLM_ERROR", f"对话失败：{exc}", 502)

    # 回复转语音（截断到 TTS 上限），失败不阻塞：降级为纯文本回复
    audio_b64 = ""
    tts_text = reply_text[:MAX_TTS_CHARS]
    if tts_text:
        wav_path = await asyncio.to_thread(tts_service.synthesize, tts_text)
        if wav_path is not None:
            try:
                audio_b64 = base64.b64encode(wav_path.read_bytes()).decode("ascii")
            finally:
                wav_path.unlink(missing_ok=True)
        else:
            logger.warning("TTS 不可用，本次回复降级为纯文本：%s", tts_service.status().get("error"))

    return {
        "user_text": user_text,
        "user_audio_seconds": round(user_seconds, 1),
        "reply_text": reply_text,
        "audio": audio_b64,
        "tts_engine": tts_service.engine,
        "llm_configured": chat_service.configured,
    }


@app.post("/api/tts")
async def api_tts(payload: dict):
    text = (payload.get("text") or "").strip()
    if not text:
        raise _err("EMPTY_TEXT", "文本不能为空", 400)
    if len(text) > MAX_TTS_CHARS:
        raise _err("TEXT_TOO_LONG",
                   f"文本长度 {len(text)} 超过 {MAX_TTS_CHARS} 字限制，请分段合成", 400)

    wav_path = await asyncio.to_thread(tts_service.synthesize, text)
    if wav_path is None:
        raise _err("TTS_UNAVAILABLE",
                   f"语音合成引擎不可用：{tts_service.status().get('error')}", 503)

    return FileResponse(
        path=wav_path,
        media_type="audio/wav",
        background=BackgroundTask(_remove_file, wav_path),
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc: Exception):
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": {"code": "INTERNAL_ERROR", "message": f"服务器内部错误：{exc}"}},
    )


# 前端静态页（必须最后挂载，/api/* 优先匹配）
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
else:  # pragma: no cover
    logger.warning("前端目录不存在：%s，仅提供 API", FRONTEND_DIR)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=6700, log_level="info")
