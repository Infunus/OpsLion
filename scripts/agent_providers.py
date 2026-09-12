"""Wire-format adapters. Planning, validation and execution policy stay in agent_runtime."""
from __future__ import annotations

import copy
import json
import math
import re
from pathlib import Path
from urllib.parse import quote

PROVIDERS = {item["id"]: item for item in json.loads(
    (Path(__file__).resolve().parents[1] / "config" / "agent-providers.json").read_text(encoding="utf-8")
)}
PROTOCOLS = {"openai-chat", "openai-responses", "anthropic", "gemini"}


def api_root(base_url: str) -> str:
    root = base_url.rstrip("/")
    root = re.sub(r"/models/[^/]+:generateContent$", "", root)
    for suffix in ("/chat/completions", "/responses", "/messages"):
        if root.endswith(suffix):
            return root[:-len(suffix)]
    return root


def build_request(config: dict, messages: list[dict], json_mode: bool) -> tuple[str, dict, dict]:
    protocol = config.get("protocol", "openai-chat")
    if protocol not in PROTOCOLS:
        raise ValueError("不支持这个 API 协议")
    root = api_root(config["base_url"])
    key = config.get("api_key", "")
    headers = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "OpsLion-Agent/0.2"}
    limit = config.get("max_output_tokens", 4096)
    use_json = json_mode and config.get("json_mode", "auto") != "off"
    system = "\n\n".join(m["content"] for m in messages if m["role"] in {"system", "developer"})
    turns = [m for m in messages if m["role"] not in {"system", "developer"}]
    if protocol == "anthropic":
        endpoint = f"{root}/messages"
        headers["anthropic-version"] = "2023-06-01"
        if key:
            headers["x-api-key"] = key
        payload = {"model": config["model"], "system": system, "max_tokens": limit, "stream": False,
                   "messages": [{"role": m["role"], "content": m.get("_anthropic_content", m["content"])} for m in turns]}
        # Plain JSON is requested by the task prompt. Messages has no json_object mode;
        # requiring its newer JSON-schema feature would exclude older Claude models.
    elif protocol == "gemini":
        model = config["model"].removeprefix("models/")
        endpoint = f"{root}/models/{quote(model, safe='')}:generateContent"
        if key:
            headers["x-goog-api-key"] = key
        payload = {"systemInstruction": {"parts": [{"text": system}]},
                   "contents": [{"role": "model" if m["role"] == "assistant" else "user",
                                 "parts": m.get("_gemini_parts", [{"text": m["content"]}])} for m in turns],
                   "generationConfig": {"maxOutputTokens": limit}}
        if use_json:
            payload["generationConfig"]["responseMimeType"] = "application/json"
    elif protocol == "openai-responses":
        endpoint = f"{root}/responses"
        if key:
            headers["Authorization"] = f"Bearer {key}"
        # Stateless repair: replay the assistant text, never refer to an unstored
        # response item ID or require a provider-specific reasoning cache.
        inputs = [{"role": m["role"], "content": m["content"]} for m in turns]
        payload = {"model": config["model"], "instructions": system, "input": inputs,
                   "max_output_tokens": limit, "stream": False, "store": False}
        if use_json:
            payload["text"] = {"format": {"type": "json_object"}}
    else:
        endpoint = f"{root}/chat/completions"
        if key:
            headers["Authorization"] = f"Bearer {key}"
        payload = {"model": config["model"], "stream": False, "max_tokens": limit,
                   "messages": [{k: v for k, v in m.items() if k in {"role", "content", "reasoning_content", "reasoning_details"}} for m in messages]}
        if use_json:
            payload["response_format"] = {"type": "json_object"}
        if config.get("provider") == "minimax":
            payload["reasoning_split"] = True
    if config.get("send_temperature", True):
        target = payload["generationConfig"] if protocol == "gemini" else payload
        target["temperature"] = config.get("temperature", 0.1)
    return endpoint, headers, payload


def compatibility_retry(payload: dict, protocol: str, detail: str) -> bool:
    """At most one transport retry, to the same endpoint, under the shared budget."""
    before = copy.deepcopy(payload)
    detail = detail.lower()
    if any(field in detail for field in ("response_format", "text.format", "json_object", "responsemimetype", "response_mime_type", "temperature")):
        payload.pop("temperature", None)
        payload.pop("response_format", None)
        if protocol == "openai-responses":
            payload.pop("text", None)
        if protocol == "gemini":
            payload["generationConfig"].pop("temperature", None)
            payload["generationConfig"].pop("responseMimeType", None)
    if protocol == "openai-chat" and "max_tokens" in detail and "max_completion_tokens" in detail and "max_tokens" in payload:
        payload["max_completion_tokens"] = payload.pop("max_tokens")
        payload.pop("temperature", None)
    if "enable_thinking" in detail and "false" in detail:
        payload["enable_thinking"] = False
    return before != payload


def _counters(value: object, aliases: dict) -> dict | None:
    if not isinstance(value, dict):
        return None
    counters = {k: v for k, v in value.items() if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0}
    for source, target in aliases.items():
        if source in counters:
            counters[target] = counters[source]
    return counters or None


def _parts_text(parts: object, kind: str) -> str:
    if not isinstance(parts, list):
        raise ValueError("模型响应缺少文本内容")
    return "".join(p["text"] for p in parts if isinstance(p, dict) and isinstance(p.get("text"), str)
                   and not p.get("thought") and (not kind or p.get("type") == kind)).strip()


def normalize_response(response: dict, protocol: str) -> dict:
    if response.get("error") or response.get("type") == "error":
        raise ValueError("模型接口返回了错误结果，请检查模型权限与接口配置")
    if protocol == "openai-chat":
        choices = response.get("choices")
        choice = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else {}
        message = choice.get("message") or {}
        if not isinstance(message, dict):
            raise ValueError("模型响应缺少消息对象")
        if choice.get("finish_reason") in {"tool_calls", "function_call", "error"}:
            raise ValueError("模型未返回可用的排版计划")
        response["usage"] = _counters(response.get("usage"), {})
        response["_assistant"] = {k: v for k, v in message.items() if k in {"content", "reasoning_content", "reasoning_details"}}
        return response
    if protocol == "anthropic":
        reason = response.get("stop_reason")
        if reason in {"max_tokens", "model_context_window_exceeded"}:
            raise ValueError("模型输出被截断，可在高级设置提高输出上限；本地稿已保留")
        if reason not in {"end_turn", "stop_sequence"}:
            raise ValueError("模型拒绝请求或未完成文本输出；本地稿已保留")
        content = _parts_text(response.get("content"), "text")
        usage = _counters(response.get("usage"), {"input_tokens": "prompt_tokens", "output_tokens": "completion_tokens"})
        assistant = {"_anthropic_content": response["content"]}
    elif protocol == "gemini":
        if (response.get("promptFeedback") or {}).get("blockReason"):
            raise ValueError("模型过滤了本次输入；本地稿已保留")
        candidates = response.get("candidates")
        candidate = candidates[0] if isinstance(candidates, list) and candidates and isinstance(candidates[0], dict) else {}
        if candidate.get("finishReason") == "MAX_TOKENS":
            raise ValueError("模型输出被截断，可在高级设置提高输出上限；本地稿已保留")
        if candidate.get("finishReason") != "STOP":
            raise ValueError("模型过滤请求或未完成文本输出；本地稿已保留")
        parts = (candidate.get("content") or {}).get("parts")
        content = _parts_text(parts, "")
        usage = _counters(response.get("usageMetadata"), {"promptTokenCount": "prompt_tokens", "candidatesTokenCount": "completion_tokens", "totalTokenCount": "total_tokens", "thoughtsTokenCount": "reasoning_tokens"})
        assistant = {"_gemini_parts": parts}
    elif protocol == "openai-responses":
        if response.get("status") == "incomplete":
            raise ValueError("模型输出被截断或过滤；本地稿已保留")
        if response.get("status") != "completed" or not isinstance(response.get("output"), list):
            raise ValueError("模型响应尚未完成；本地稿已保留")
        parts = []
        for item in response["output"]:
            if isinstance(item, dict) and item.get("type") == "message":
                if item.get("status", "completed") != "completed" or not isinstance(item.get("content"), list):
                    raise ValueError("模型消息不完整；本地稿已保留")
                parts.extend(item["content"])
        if any(isinstance(p, dict) and p.get("type") == "refusal" for p in parts):
            raise ValueError("模型拒绝了本次请求；本地稿已保留")
        content = _parts_text(parts, "output_text")
        usage = _counters(response.get("usage"), {"input_tokens": "prompt_tokens", "output_tokens": "completion_tokens"})
        assistant = {}
    else:
        raise ValueError("不支持这个 API 协议")
    if not content:
        raise ValueError("模型响应缺少可读取的文本内容")
    return {"choices": [{"message": {"content": content}, "finish_reason": "stop"}],
            "usage": usage, "_assistant": {"content": content, **assistant}}
