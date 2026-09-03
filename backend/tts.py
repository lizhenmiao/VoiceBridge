"""语音合成：调用 OpenAI 兼容的 /audio/speech（grok-voice）。

上游可返回 mp3/opus/wav 等格式，这里统一请求 wav，再经 ffmpeg
转成 16kHz/mono/PCM16。失败时返回 None，原因记入 status().error。
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path

import requests

from audio_utils import make_tmp, transcode_file_to_16k_mono_wav
from config import TTS_LANGUAGE, TTS_MODEL, TTS_VOICE, VOICE_API_BASE_URL, VOICE_API_KEY

logger = logging.getLogger("voicebridge.tts")

# response_format=wav 由上游保证；个别网关不认时改用 mp3 也能被 ffmpeg 解
RESPONSE_FORMAT = "wav"


class TTSService:
    def __init__(self):
        self.base_url = VOICE_API_BASE_URL
        self.api_key = VOICE_API_KEY
        self.model = TTS_MODEL
        self.voice = TTS_VOICE
        self.language = TTS_LANGUAGE
        self.engine = "none"  # none | grok-voice
        self._error: str | None = None
        self._lock = threading.Lock()

    def ensure_loaded(self) -> str | None:
        """保持与原本地实现相同的调用契约：配置就绪返回引擎名，否则 None + 原因。"""
        if self.engine != "none":
            return self.engine
        with self._lock:
            if self.engine != "none":
                return self.engine
            if not self.api_key or not self.base_url:
                self._error = "未配置 VOICE_API_BASE_URL / VOICE_API_KEY（复制 .env.example 为 .env 并填写）"
                return None
            self._error = None
            self.engine = "grok-voice"
            logger.info("TTS 引擎就绪：grok-voice（model=%s, voice=%s）", self.model, self.voice)
            return self.engine

    def synthesize(self, text: str) -> Path | None:
        """合成 16k/mono wav；成功返回文件路径（调用方负责删除），失败返回 None。

        注意：返回的文件不能放在自动清理的 context manager 里，
        否则 return 后即被删除（FileResponse/main 还要读取）。
        """
        if self.ensure_loaded() is None:
            return None
        with self._lock:
            raw = make_tmp(".wav")
            out = make_tmp(".wav")
            try:
                resp = requests.post(
                    f"{self.base_url}/audio/speech",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json={
                        "model": self.model,
                        "input": text,
                        "voice": self.voice,
                        "response_format": RESPONSE_FORMAT,
                        "speed": 1,
                        "language": self.language,
                    },
                    timeout=120,
                )
                if resp.status_code != 200:
                    detail = resp.text[:200]
                    hint = {401: "鉴权失败，请检查 VOICE_API_KEY"}.get(
                        resp.status_code, "语音合成接口异常"
                    )
                    self._error = f"{hint}（HTTP {resp.status_code}）"
                    logger.error("TTS HTTP %s：%s", resp.status_code, detail)
                    return None
                raw.write_bytes(resp.content)
                transcode_file_to_16k_mono_wav(raw, out)
                return out
            except Exception as exc:  # noqa: BLE001 - 网络抖动/转码失败都归入引擎错误
                self._error = f"{type(exc).__name__}: {exc}"
                logger.exception("TTS 合成失败")
                out.unlink(missing_ok=True)
                return None
            finally:
                raw.unlink(missing_ok=True)

    def status(self) -> dict:
        return {
            "engine": self.engine,
            "loaded": self.engine == "grok-voice",
            "model": self.model,
            "voice": self.voice,
            "base_url": self.base_url,
            "error": self._error,
        }
