"""集中配置：所有参数可通过环境变量覆盖。

语音链路走 OpenAI 兼容云端接口（grok-stt / grok-voice），本地只做
ffmpeg 转码（统一 16kHz/mono/PCM16 wav）与时长/大小校验。
"""

from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 目录
TMP_DIR = Path(os.getenv("TMP_DIR", str(PROJECT_ROOT / "tmp")))

# ---- 安全与限制 ----
MAX_UPLOAD_MB = float(os.getenv("MAX_UPLOAD_MB", "20"))
MAX_RECORD_SECONDS = float(os.getenv("MAX_RECORD_SECONDS", "60"))
MAX_TTS_CHARS = int(os.getenv("MAX_TTS_CHARS", "500"))

# 调试模式：开启后上传/中间音频保留到 tmp/debug，默认不保存任何用户音频
DEBUG_KEEP_AUDIO = os.getenv("SAVE_DEBUG_AUDIO", "0") == "1"

# ---- 语音引擎（OpenAI 兼容，具体网关地址与模型名在 .env 中配置）----
ASR_ENABLED = os.getenv("ASR_ENABLED", "1") == "1"
VOICE_API_BASE_URL = os.getenv("VOICE_API_BASE_URL", "").rstrip("/")
VOICE_API_KEY = os.getenv("VOICE_API_KEY", "").strip()
STT_MODEL = os.getenv("STT_MODEL", "grok-stt")
STT_LANGUAGE = os.getenv("STT_LANGUAGE", "zh")
TTS_MODEL = os.getenv("TTS_MODEL", "grok-voice-think-fast-2.0")
TTS_VOICE = os.getenv("TTS_VOICE", "alloy")
TTS_LANGUAGE = os.getenv("TTS_LANGUAGE", "zh")

# ---- 大模型（OpenAI 兼容 /chat/completions，可与语音同一服务）----
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "").rstrip("/")
LLM_KEY = os.getenv("LLM_KEY", "").strip()
LLM_MODEL = os.getenv("LLM_MODEL", "grok-chat-fast")  # 按网关实际可用模型名调整

# ---- 实时通话（OpenAI Realtime 兼容 WebSocket 代理）----
# 复用 VOICE_API_BASE_URL / VOICE_API_KEY；REALTIME_MODEL 按网关可用模型调整
REALTIME_MODEL = os.getenv("REALTIME_MODEL", "grok-voice-think-fast-2.0")
# 上游 pcm16 格式的固定采样率为 24kHz（OpenAI Realtime 标准），
# 浏览器采集与播放都必须按此率重采样，否则 VAD 与模型听到的音频全部失真
REALTIME_IN_RATE = int(os.getenv("REALTIME_IN_RATE", "24000"))
REALTIME_OUT_RATE = int(os.getenv("REALTIME_OUT_RATE", "24000"))
