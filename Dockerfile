# VoiceBridge 后端镜像：Python 3.11 + 静态 ffmpeg（云端语音版，无本地大模型）

# 静态编译的 ffmpeg/ffprobe：单文件自带 opus/aac 等常用编解码，
# 避免 apt 安装 ffmpeg 拖入 ~460MB 系统依赖
FROM mwader/static-ffmpeg:7.1 AS ffmpeg

FROM python:3.11-slim-bookworm

# 国内网络默认走清华 PyPI 镜像；海外环境可 build 时覆盖：
# --build-arg PIP_INDEX_URL=https://pypi.org/simple
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    TMP_DIR=/app/tmp

WORKDIR /app

# 只取两个静态可执行文件，无任何系统依赖
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

COPY backend /app/backend
COPY frontend /app/frontend

RUN mkdir -p /app/tmp

EXPOSE 6700

WORKDIR /app/backend

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "6700"]
