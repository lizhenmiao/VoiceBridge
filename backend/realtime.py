"""实时通话：浏览器 ↔ 本服务 ↔ 上游 Realtime WebSocket 的双向代理。

浏览器无法在 WebSocket 握手中携带 Authorization 头（浏览器标准限制），
key 必须由本服务代持——浏览器只连本服务的 /ws/realtime，
本服务再带上 Bearer 连上游 /v1/realtime?model=<REALTIME_MODEL>。

事件协议（OpenAI Realtime 兼容，双向都是 JSON 文本帧）：
  浏览器 → 上游：input_audio_buffer.append / commit / response.create 等原样转发
  上游 → 浏览器：session.* / response.audio_transcript.* / response.done 等原样转发
  音频：上游 response.*audio*.delta 里的 base64 PCM 解码为二进制帧发给浏览器；
        浏览器发来的二进制帧（16bit PCM 小端）包装为 input_audio_buffer.append

建立连接后本服务先给浏览器发 {"type":"session.config","in_rate":..,"out_rate":..}，
再向上游注入 session.update（voice / instructions / server_vad / 转写配置）。
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import urllib.parse

import websockets
from fastapi import WebSocket, WebSocketDisconnect

from chat import chat_service
from config import (
    REALTIME_IN_RATE,
    REALTIME_MODEL,
    REALTIME_OUT_RATE,
    VOICE_API_BASE_URL,
    VOICE_API_KEY,
)

logger = logging.getLogger("voicebridge.realtime")


def _upstream_url() -> str:
    base = VOICE_API_BASE_URL.rstrip("/")
    ws_base = base.replace("https://", "wss://").replace("http://", "ws://")
    return f"{ws_base}/realtime?model={urllib.parse.quote(REALTIME_MODEL)}"


def _session_update() -> str:
    # voice 不下发：网关使用自有音色命名（如 xai_ara），OpenAI 音色名不被识别
    # turn_detection 关闭 server_vad：实测上游 VAD 自动回复路径会导致连接被关闭，
    # 改由浏览器端做静音检测，说完后由前端发送 commit + response.create（已验证可用）
    return json.dumps({
        "type": "session.update",
        "session": {
            "modalities": ["text", "audio"],
            "instructions": chat_service.system_prompt,
            "input_audio_format": "pcm16",
            "output_audio_format": "pcm16",
            "input_audio_transcription": {"model": "grok-stt"},
            "turn_detection": None,
        },
    }, ensure_ascii=False)


async def _connect_upstream(url: str, headers: dict):
    """websockets 14+ 用 additional_headers，<=13 用 extra_headers，兼容两者。"""
    try:
        return await websockets.connect(
            url, additional_headers=headers,
            max_size=None, ping_interval=20, ping_timeout=20, open_timeout=20,
        )
    except TypeError:
        return await websockets.connect(
            url, extra_headers=headers,
            max_size=None, ping_interval=20, ping_timeout=20, open_timeout=20,
        )


async def realtime_proxy(browser_ws: WebSocket) -> None:
    await browser_ws.accept()

    if not VOICE_API_BASE_URL or not VOICE_API_KEY:
        await browser_ws.send_json({
            "type": "error",
            "error": {"message": "服务未配置 VOICE_API_BASE_URL / VOICE_API_KEY，无法实时通话"},
        })
        await browser_ws.close()
        return

    # 1) 告知浏览器音频规格（采集重采样到 in_rate，播放按 out_rate）
    await browser_ws.send_json({
        "type": "session.config",
        "model": REALTIME_MODEL,
        "in_rate": REALTIME_IN_RATE,
        "out_rate": REALTIME_OUT_RATE,
    })

    # 2) 连上游（代持鉴权）
    try:
        upstream = await _connect_upstream(
            _upstream_url(),
            {"Authorization": f"Bearer {VOICE_API_KEY}", "Content-Type": "application/json"},
        )
    except Exception as exc:  # noqa: BLE001 - 握手失败要把原因告诉浏览器
        logger.error("上游 Realtime 连接失败：%s", exc)
        await browser_ws.send_json({
            "type": "error",
            "error": {"message": f"连接实时语音网关失败：{exc}"},
        })
        await browser_ws.close()
        return

    logger.info("实时通话建立（model=%s）", REALTIME_MODEL)

    # 3) 注入 session 配置
    try:
        await upstream.send(_session_update())
    except Exception as exc:  # noqa: BLE001
        logger.warning("session.update 发送失败：%s", exc)

    # 4) 双向泵
    upstream_closed = asyncio.Event()

    async def browser_to_upstream():
        while True:
            msg = await browser_ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("text") is not None:
                await upstream.send(msg["text"])
            elif msg.get("bytes") is not None:
                event = {
                    "type": "input_audio_buffer.append",
                    "audio": base64.b64encode(msg["bytes"]).decode("ascii"),
                }
                await upstream.send(json.dumps(event))

    async def upstream_to_browser():
        """上游 → 浏览器转发，并修补网关的已知缺陷：

        网关的 server_vad「识别完成 → 自动应答」路径存在缺陷（转写完成后
        直接关闭连接、不出回复音频）。因此这里把上游的 server_vad 当作
        纯检测器使用：speech_started/stopped 原样转发给前端做状态展示，
        当检测到"一轮语音结束"后，由代理主动补发 commit + response.create
        走已验证可用的手动应答路径。
        """
        speech_active = False
        last_speech_ts = 0.0

        async for raw in upstream:
            text = raw if isinstance(raw, str) else raw.decode("utf-8", "replace")
            try:
                event = json.loads(text)
            except ValueError:
                await browser_ws.send_text(text)
                continue
            etype = event.get("type", "")
            delta = event.get("delta")

            # 音频增量 → 解码为二进制 PCM 帧给浏览器
            if isinstance(delta, str) and delta and "audio" in etype and "transcript" not in etype:
                await browser_ws.send_bytes(base64.b64decode(delta))
                continue

            # 记录语音起止时刻
            if etype == "input_audio_buffer.speech_started":
                speech_active = True
                last_speech_ts = asyncio.get_event_loop().time()
            elif etype == "input_audio_buffer.speech_stopped":
                speech_active = False
                last_speech_ts = asyncio.get_event_loop().time()

            # 转写完成 = 这句话在上游已经收完了，立即补 commit + create
            # （网关此时会关连接，必须抢在它之前）
            if etype == "conversation.item.input_audio_transcription.completed":
                try:
                    await upstream.send(json.dumps({"type": "input_audio_buffer.commit"}))
                    await upstream.send(json.dumps({"type": "response.create"}))
                    logger.info("已为 VAD 语音补发 commit + response.create")
                except Exception as exc:  # noqa: BLE001
                    logger.warning("补发应答失败：%s", exc)

            await browser_ws.send_text(json.dumps(event, ensure_ascii=False))

    browser_task = asyncio.create_task(browser_to_upstream())
    upstream_task = asyncio.create_task(upstream_to_browser())
    done, pending = await asyncio.wait(
        {browser_task, upstream_task}, return_when=asyncio.FIRST_COMPLETED
    )
    for task in pending:
        task.cancel()
    for task in done:
        exc = task.exception()
        if exc and not isinstance(exc, (WebSocketDisconnect, asyncio.CancelledError,
                                        websockets.ConnectionClosed)):
            logger.warning("实时通话异常断开：%s: %s", type(exc).__name__, exc)

    try:
        await upstream.close()
    except Exception:  # noqa: BLE001
        pass
    try:
        await browser_ws.close()
    except Exception:  # noqa: BLE001
        pass
    logger.info("实时通话结束")
