# VoiceBridge（声桥）

微信风格的中文语音对话助手 H5：**按住说话 → 云端 grok-stt 识别 → 大模型回复 → grok-voice 合成 → 语音条卡片点击播放**。

- **语音输入（ASR）**：`grok-stt`（OpenAI 兼容 `/v1/audio/transcriptions`）
- **语音输出（TTS）**：`grok-voice-think-fast-2.0`（OpenAI 兼容 `/v1/audio/speech`）
- **大模型（可选）**：OpenAI 兼容 `/v1/chat/completions`；未配置 `LLM_KEY` 时返回本地演示回复
- **音频**：上传音频由后端 ffmpeg 统一转 **16kHz / 单声道 / PCM 16-bit wav** 后再送云端
- **前端**：原生 HTML/JS，按住说话（上滑取消）、语音条卡片点击播放，兼容 Chrome / Edge / Firefox / iOS Safari 14.3+ / 微信内置浏览器

> **架构变化说明**：早期版本使用本地 FunASR + MeloTTS（全离线），因纯 CPU 推理过慢（实测一轮对话 30 秒+）已切换为云端语音接口。本地仅保留 ffmpeg 转码与限流逻辑，镜像从 ~5GB 瘦身到 ~600MB（静态 ffmpeg）。语音数据会发送到你配置的云端接口，隐私敏感场景请自建网关。

## 目录结构

```
VoiceBridge/
├── backend/
│   ├── main.py           # FastAPI 入口：/api/chat /api/asr /api/tts /api/health
│   ├── asr.py            # grok-stt 转写客户端
│   ├── tts.py            # grok-voice 合成客户端
│   ├── chat.py           # LLM 对话客户端
│   ├── audio_utils.py    # ffmpeg 探测/转码、临时文件自动清理
│   ├── config.py         # 环境变量集中配置
│   └── requirements.txt
├── frontend/             # 微信风格对话界面（index.html / app.js / style.css）
├── tmp/                  # 临时音频（请求结束自动删除）
├── Dockerfile
├── docker-compose.yml
└── README.md
```

## 快速开始

```bash
# 1. 复制配置模板并填入真实值（key、base_url、模型名都在 .env 管理）
cp .env.example .env
#    编辑 .env：VOICE_API_KEY / LLM_KEY 填入网关签发的 API Key

# 2. 构建并启动（docker compose 自动读取 .env）
docker compose up -d --build
```

浏览器打开：<http://localhost:6700>，按住麦克风说话即可。

> `.env` 含密钥，已在 `.gitignore` 中排除；`docker-compose.yml` 只是变量引用模板，不含任何真实配置。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `VOICE_API_KEY` | 空 | **必填**。语音接口的 API Key，STT 和 TTS 共用，配置在 `.env` |
| `VOICE_API_BASE_URL` | 空 | OpenAI 兼容语音接口地址（在 `.env` 中配置） |
| `STT_MODEL` | `grok-stt` | 转写模型 |
| `TTS_MODEL` | `grok-voice-think-fast-2.0` | 语音合成模型 |
| `TTS_VOICE` | `alloy` | 音色（OpenAI 音色名或 Console voice_id） |
| `STT_LANGUAGE` / `TTS_LANGUAGE` | `zh` | 语言代码 |
| `LLM_KEY` | 空 | 大模型 key；留空 = 本地演示回复 |
| `LLM_BASE_URL` | 同语音接口 | `/chat/completions` 地址 |
| `LLM_MODEL` | `grok-4-fast` | 对话模型名（按中转站实际可用调整） |
| `MAX_UPLOAD_MB` | `20` | 上传音频大小上限 |
| `MAX_RECORD_SECONDS` | `60` | 录音时长上限 |
| `MAX_TTS_CHARS` | `500` | 合成文本长度上限 |
| `SAVE_DEBUG_AUDIO` | `0` | `1` 时中间音频保留到 `tmp/debug/`（默认不保存） |

## 接口说明

### `POST /api/chat` — 对话接口（前端使用）

`multipart/form-data`：`file`（录音，可选）/ `text`（文字，可选）二选一，`history`（JSON 数组，多轮上下文）。

链路：`语音/文字 → ASR → LLM → TTS`，返回：

```json
{
  "user_text": "你好呀",
  "user_audio_seconds": 2.3,
  "reply_text": "你好！有什么可以帮你？",
  "audio": "<base64 的 16kHz 单声道 wav>",
  "tts_engine": "grok-voice",
  "llm_configured": true
}
```

### `POST /api/asr` — 语音识别

`multipart/form-data` 字段 `file`（webm/mp4/ogg/wav），返回 `{"text": "..."}`。ffmpeg 探测真实格式并统一转 16k wav 后送 `grok-stt`。

### `POST /api/tts` — 语音合成

`{"text": "..."}`（≤500 字），返回 `audio/wav`（16kHz/mono/PCM16）。

### `GET /api/health`

```json
{
  "status": "ok",
  "asr": {"enabled": true, "loaded": true, "model": "grok-stt", "error": null},
  "tts": {"engine": "grok-voice", "loaded": true, "model": "grok-voice-think-fast-2.0", "error": null},
  "chat": {"llm_configured": true, "model": "grok-4-fast"},
  "ffmpeg": true,
  "limits": {...}
}
```

`VOICE_API_KEY` 未配置时 `asr.loaded=false`、`tts.engine="none"`，并在 `error` 中说明。

## 常见问题

**1. 页面提示"未配置 VOICE_API_KEY"？**
在 docker-compose.yml 中把 `VOICE_API_KEY` 填上你的 key 后 `docker compose up -d` 重启。

**2. 401 鉴权失败？**
key 抄错或过期；核对 key 是否与网关签发的一致（OpenAI 官方为 `sk-` 开头，其他网关的前缀以各自文档为准），并确认 `.env` 中 Base URL 正确（通常以 `/v1` 结尾）。

**3. 大模型报 404 / model not found？**
`LLM_MODEL` 名字与中转站实际提供的不一致，用它的模型列表接口或后台确认（常见：`grok-4-fast`、`grok-4`、`grok-3` 等）。

**4. 手机上不能录音？**
麦克风权限需要 **https 或 localhost**；iOS 需要 14.3+。局域网手机访问请加 https 反代。

**5. 识别/合成报网络错误？**
`docker logs voicebridge` 看具体 HTTP 状态；中转站限流时稍后重试。

**6. 想回退到全离线方案？**
当前代码为纯云端版（依赖：fastapi + 静态 ffmpeg，镜像 ~600MB）。早期 FunASR + MeloTTS 本地版（全离线，镜像 ~5GB，纯 CPU 合成慢）已从代码中移除，如需恢复告诉我即可基于原实现重建。

## 安全与限制

- 上传 ≤ 20MB、录音 ≤ 60 秒、TTS 文本 ≤ 500 字（前后端双重校验）
- 临时文件请求结束即删；默认**不保存**任何用户音频
- **语音与文本会发送到你配置的云端接口**（见 `.env` 中 `VOICE_API_BASE_URL` / `LLM_BASE_URL`），敏感场景请自建网关或回退本地方案
- 服务无鉴权，仅供局域网/本机使用；公网部署请自行加网关鉴权与限流
