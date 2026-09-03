"""对话服务：把用户输入交给大模型（OpenAI 兼容接口，如 grok / GLM / DeepSeek / vLLM）。

语音模式的数据流（/api/chat）：
  用户语音 → grok-stt 转文本 → LLM 生成回复文本 → grok-voice 合成 wav 返回
纯文本模式：
  用户文本 → LLM → 回复文本

LLM_KEY 未配置时自动降级为本地演示回复，保证页面可以先跑起来看交互效果。
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Optional

import requests

from config import LLM_BASE_URL, LLM_KEY, LLM_MODEL

logger = logging.getLogger("voicebridge.chat")

DEFAULT_SYSTEM_PROMPT = (
    "你是 VoiceBridge 声桥，一个中文语音助手。回答要口语化、简洁，"
    "一般不超过两三句话，因为你的回答会被转成语音播报给用户。不要使用 Markdown 格式。"
)


class ChatService:
    def __init__(self):
        self.base_url = LLM_BASE_URL
        self.api_key = LLM_KEY
        self.model = LLM_MODEL
        self.system_prompt = os.getenv(
            "LLM_SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT
        )
        self.timeout = float(os.getenv("LLM_TIMEOUT", "60"))
        self._lock = threading.Lock()

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def ask(self, user_text: str, history: Optional[list] = None) -> str:
        """调用 LLM 生成回复。未配置 LLM_KEY 时返回本地演示回复。"""
        user_text = (user_text or "").strip()
        if not user_text:
            raise ValueError("empty user text")

        if not self.configured:
            return (
                f"（本地演示回复，尚未配置大模型）我收到了你说的话：「{user_text}」。"
                "请在 .env 中设置 LLM_KEY、LLM_BASE_URL、LLM_MODEL 接入真实大模型。"
            )
        if not self.base_url:
            raise RuntimeError("未配置 LLM_BASE_URL（请参考 .env.example 配置 .env）")

        messages = [{"role": "system", "content": self.system_prompt}]
        for turn in (history or [])[-10:]:
            role = turn.get("role")
            content = (turn.get("content") or "").strip()
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content[:1000]})
        messages.append({"role": "user", "content": user_text})

        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.7,
            "max_tokens": 500,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        with self._lock:  # 单实例部署：串行请求，避免并发打爆免费/中转额度
            start = time.time()
            resp = requests.post(
                f"{self.base_url}/chat/completions",
                json=payload,
                headers=headers,
                timeout=self.timeout,
            )
        if resp.status_code != 200:
            detail = resp.text[:200]
            logger.error("LLM 返回 %s：%s", resp.status_code, detail)
            raise RuntimeError(
                f"大模型服务返回 HTTP {resp.status_code}，请检查 LLM_KEY / LLM_BASE_URL / LLM_MODEL 配置"
            )

        data = resp.json()
        try:
            text = data["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError(f"大模型返回格式异常：{str(data)[:200]}") from exc
        logger.info("LLM 回复（%.1fs，%d 字）", time.time() - start, len(text))
        return text


chat_service = ChatService()
