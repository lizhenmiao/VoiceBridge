"""语音识别：调用 OpenAI 兼容的 /audio/transcriptions（grok-stt）。

输入是本地 ffmpeg 统一转好的 16kHz 单声道 wav；网络与鉴权错误
都转成带中文说明的 RuntimeError，由上层返回给前端。
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path

import requests

from config import ASR_ENABLED, STT_LANGUAGE, STT_MODEL, VOICE_API_BASE_URL, VOICE_API_KEY

logger = logging.getLogger("voicebridge.asr")


class ASRService:
    def __init__(self):
        self.base_url = VOICE_API_BASE_URL
        self.api_key = VOICE_API_KEY
        self.model = STT_MODEL
        self.language = STT_LANGUAGE
        self._error: str | None = None
        self._lock = threading.Lock()

    def ensure_loaded(self):
        """保持与原本地实现相同的调用契约：配置就绪返回模型名，否则 None + 原因。"""
        if not self.base_url or not self.api_key:
            self._error = "未配置 VOICE_API_BASE_URL / VOICE_API_KEY（复制 .env.example 为 .env 并填写）"
            return None
        self._error = None
        return self.model

    def transcribe(self, wav_path: Path) -> str:
        model = self.ensure_loaded()
        if model is None:
            raise RuntimeError(self._error or "语音识别未配置")
        with self._lock:
            resp = requests.post(
                f"{self.base_url}/audio/transcriptions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                data={"model": self.model, "language": self.language, "response_format": "json"},
                files={"file": (wav_path.name, wav_path.read_bytes(), "audio/wav")},
                timeout=120,
            )
        if resp.status_code != 200:
            detail = resp.text[:200]
            hint = {401: "鉴权失败，请检查 VOICE_API_KEY", 404: "接口路径不存在，请检查 VOICE_API_BASE_URL"}.get(
                resp.status_code, "语音识别接口异常"
            )
            logger.error("STT HTTP %s：%s", resp.status_code, detail)
            raise RuntimeError(f"{hint}（HTTP {resp.status_code}）")
        try:
            return str(resp.json().get("text", "")).strip()
        except ValueError as exc:
            raise RuntimeError(f"语音识别响应不是 JSON：{resp.text[:200]}") from exc

    def status(self) -> dict:
        return {
            "enabled": ASR_ENABLED,
            "loaded": bool(self.api_key),
            "model": self.model,
            "base_url": self.base_url,
            "error": self._error,
        }
