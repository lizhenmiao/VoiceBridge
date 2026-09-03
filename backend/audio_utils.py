"""音频处理工具：ffmpeg 探测与转码（统一为 16kHz / mono / PCM16 wav）。

所有临时文件走 context manager，请求结束自动清理。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from config import DEBUG_KEEP_AUDIO, TMP_DIR


def make_tmp(suffix: str = "") -> Path:
    """生成 tmp 目录下不冲突的临时文件路径（不自动删除，由调用方负责清理）。"""
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    return TMP_DIR / f"vb_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}{suffix}"


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


class AudioError(Exception):
    """转码/探测失败，message 面向最终用户。"""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


@dataclass
class AudioInfo:
    duration: float
    sample_rate: int
    channels: int


@contextmanager
def temp_path(suffix: str = ""):
    """在 tmp 目录下创建临时文件路径，用完即删（调试模式保留到 tmp/debug）。

    唯一性必须用 UUID：id(object()) 会被 CPython 地址复用，
    同一毫秒内两次调用可能生成同名文件（ffmpeg 报 Output same as Input）。
    """
    path = make_tmp(suffix)
    try:
        yield path
    finally:
        if DEBUG_KEEP_AUDIO:
            debug_dir = TMP_DIR / "debug"
            debug_dir.mkdir(parents=True, exist_ok=True)
            if path.exists():
                shutil.move(str(path), str(debug_dir / path.name))
        else:
            path.unlink(missing_ok=True)


@contextmanager
def transcode_to_16k_mono_wav(data: bytes, source_suffix: str):
    """把任意上传音频转成 16k/mono/pcm_s16le wav。

    不信任扩展名：写入磁盘后由 ffmpeg 自动探测真实容器/编码。
    转换失败抛 AudioError，附带 ffmpeg 的 stderr 关键信息。
    """
    if not ffmpeg_available():
        raise AudioError("服务器未安装 ffmpeg，无法处理音频")

    with temp_path(f".{source_suffix}") as src, temp_path(".wav") as dst:
        src.write_bytes(data)
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(src),
            "-vn",                # 丢弃可能存在的视频轨（mp4/mov 录音常见）
            "-ac", "1",           # 单声道
            "-ar", "16000",       # 16kHz
            "-acodec", "pcm_s16le",  # PCM 16-bit
            "-f", "wav",
            str(dst),
        ]
        proc = subprocess.run(cmd, capture_output=True, timeout=120)
        if proc.returncode != 0 or not dst.exists() or dst.stat().st_size == 0:
            err = proc.stderr.decode("utf-8", errors="replace").strip()
            # 提取最后一行 ffmpeg 报错，避免整段 stderr 太长
            tail = err.splitlines()[-1] if err else "未知错误"
            raise AudioError(f"音频转码失败：{tail}")
        yield dst


def probe_audio(path: Path) -> AudioInfo | None:
    """用 ffprobe 读取时长/采样率/声道数；无法解析返回 None。"""
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        raise AudioError("服务器未安装 ffprobe，无法解析音频")
    proc = subprocess.run(
        [
            ffprobe, "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=sample_rate,channels",
            "-show_entries", "format=duration",
            "-print_format", "json",
            str(path),
        ],
        capture_output=True, timeout=30,
    )
    if proc.returncode != 0:
        return None
    try:
        meta = json.loads(proc.stdout.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        return None
    streams = meta.get("streams") or []
    stream = streams[0] if streams else {}
    fmt = meta.get("format") or {}
    try:
        duration = float(fmt.get("duration") or stream.get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0
    try:
        sample_rate = int(stream.get("sample_rate") or 16000)
    except (TypeError, ValueError):
        sample_rate = 16000
    try:
        channels = int(stream.get("channels") or 1)
    except (TypeError, ValueError):
        channels = 1
    return AudioInfo(duration=duration, sample_rate=sample_rate, channels=channels)


def transcode_file_to_16k_mono_wav(src: Path, dst: Path) -> None:
    """文件到文件的转码（TTS 后处理用），失败抛 AudioError。"""
    proc = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(src),
            "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le",
            "-f", "wav", str(dst),
        ],
        capture_output=True, timeout=120,
    )
    if proc.returncode != 0 or not dst.exists() or dst.stat().st_size == 0:
        err = proc.stderr.decode("utf-8", errors="replace").strip()
        tail = err.splitlines()[-1] if err else "未知错误"
        raise AudioError(f"TTS 结果转码失败：{tail}")
