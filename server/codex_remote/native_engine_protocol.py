"""Portable conversation and streaming adapters for native CLI connections.

Only client-side functions are portable. Hosted tools, opaque continuation
state, and file IDs need their original provider and are rejected explicitly.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from urllib.parse import urlsplit

PROTOCOLS = {"responses", "anthropic", "chat"}
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
MAX_EVENT_BYTES = 8 * 1024 * 1024


class ProtocolError(Exception):
    """A safe error; must not contain submitted content or upstream secrets."""


def normalize_base_url(base: str, protocol: str) -> str:
    base = base.rstrip("/")
    for suffix in ("/chat/completions", "/responses", "/messages"):
        if base.endswith(suffix):
            base = base[:-len(suffix)]
            break
    if protocol == "anthropic":
        return base[:-3] if base.endswith("/v1") else base
    if not urlsplit(base).path.rstrip("/"):
        return base + "/v1"
    return base


def api_endpoint(profile: dict) -> str:
    protocol = profile["protocol"]
    base = normalize_base_url(profile["baseUrl"], protocol)
    if protocol == "anthropic":
        return base + "/v1/messages"
    return base + ("/responses" if protocol == "responses" else "/chat/completions")


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _object(value: str) -> dict:
    try:
        result = json.loads(value)
    except (ValueError, TypeError):
        raise ProtocolError("上游返回了不完整的工具参数，请重试或更换支持工具调用的模型。") from None
    if not isinstance(result, dict):
        raise ProtocolError("工具参数必须为 JSON 对象。")
    return result


def _image(part: dict) -> dict:
    kind = part.get("type")
    detail = part.get("detail", "auto")
    if kind == "image":
        source = part.get("source", {})
        if source.get("type") == "base64":
            url = f"data:{source.get('media_type', 'image/png')};base64,{source.get('data', '')}"
        elif source.get("type") == "url":
            url = source.get("url", "")
        else:
            raise ProtocolError("转换连接仅支持图片 URL 或 Base64 图片。")
    elif kind == "image_url":
        image = part.get("image_url", {})
        url = image.get("url", "") if isinstance(image, dict) else image
        detail = image.get("detail", detail) if isinstance(image, dict) else detail
    else:
        url = part.get("image_url", "")
    if not isinstance(url, str) or not url.startswith(("data:image/", "https://", "http://")):
        raise ProtocolError("图片需要完整 URL 或 Base64 数据，不能使用上游文件 ID。")
    return {"type": "image", "url": url, "detail": detail}


def _parts(content: object) -> list[dict]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}] if content else []
    if content is None:
        return []
    if not isinstance(content, list):
        raise ProtocolError("消息内容格式无效。")
    parts = []
    for part in content:
        if not isinstance(part, dict):
            raise ProtocolError("消息内容格式无效。")
        kind = part.get("type")
        if kind in {"text", "input_text", "output_text", "refusal"}:
            parts.append({"type": "text", "text": part.get("text", part.get("refusal", ""))})
        elif kind in {"image", "image_url", "input_image"}:
            parts.append(_image(part))
        elif kind in {"thinking", "redacted_thinking"}:
            # Provider-specific signatures cannot be replayed to another API.
            continue
        else:
            raise ProtocolError("此消息包含无法跨协议转换的内容，请使用原生协议。")
    return parts


def _encoded_parts(parts: list[dict], protocol: str, *, assistant: bool = False) -> list[dict]:
    result = []
    for part in parts:
        if part["type"] == "text":
            kind = "output_text" if assistant else "input_text"
            result.append({"type": kind if protocol == "responses" else "text", "text": part["text"]})
        elif protocol == "responses":
            result.append({"type": "input_image", "image_url": part["url"], "detail": part["detail"]})
        elif protocol == "chat":
            result.append({"type": "image_url", "image_url": {"url": part["url"], "detail": part["detail"]}})
        else:
            url = part["url"]
            if url.startswith("data:"):
                match = re.fullmatch(r"data:(image/[^;,]+);base64,(.*)", url, re.DOTALL)
                if not match:
                    raise ProtocolError("图片 Base64 格式无效。")
                source = {"type": "base64", "media_type": match[1], "data": match[2]}
            else:
                source = {"type": "url", "url": url}
            result.append({"type": "image", "source": source})
    return result


@dataclass
class Tool:
    name: str
    alias: str
    namespace: str | None = None
    custom: bool = False
    description: str = ""
    parameters: dict = field(default_factory=dict)


class ToolRegistry:
    def __init__(self) -> None:
        self.by_alias: dict[str, Tool] = {}
        self.by_source: dict[tuple[str | None, str], Tool] = {}

    def add(self, definition: dict, namespace: str | None = None) -> Tool:
        name = definition.get("name")
        if not isinstance(name, str) or not name:
            raise ProtocolError("工具名称无效。")
        key = (namespace, name)
        existing = self.by_source.get(key)
        if existing:
            return existing
        identity = f"{namespace or ''}\0{name}"
        # Namespaces must remain distinct even if their leaf names match.
        alias = name if namespace is None and re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", name) else (
            re.sub(r"[^a-zA-Z0-9_-]", "_", name)[:43] + "_" + hashlib.sha256(identity.encode()).hexdigest()[:16]
        )
        if alias in self.by_alias:
            alias = alias[:30] + "_" + hashlib.sha256(("collision\0" + identity).encode()).hexdigest()[:32]
        custom = definition.get("type") == "custom"
        parameters = {
            "type": "object", "properties": {"input": {"type": "string"}},
            "required": ["input"], "additionalProperties": False,
        } if custom else definition.get("parameters", definition.get("input_schema", {"type": "object", "properties": {}}))
        if not isinstance(parameters, dict):
            raise ProtocolError("工具参数定义无效。")
        description = definition.get("description", "")
        if custom:
            description += "\nPass the complete tool input, unchanged, in the input string."
        tool = Tool(name, alias, namespace, custom, description, parameters)
        self.by_alias[alias] = tool
        self.by_source[key] = tool
        return tool

    def source(self, name: str, namespace: str | None = None, *, custom: bool = False) -> Tool:
        return self.by_source.get((namespace, name)) or self.add(
            {"name": name, "type": "custom" if custom else "function"}, namespace,
        )

    def decode(self, alias: str, arguments: str) -> tuple[Tool, dict]:
        tool = self.by_alias.get(alias)
        if tool is None:
            raise ProtocolError("上游调用了未声明的工具。")
        args = _object(arguments)
        if tool.custom and (set(args) != {"input"} or not isinstance(args["input"], str)):
            raise ProtocolError("上游未按要求返回完整的文本工具输入。")
        return tool, args


@dataclass
class Conversation:
    model: str
    stream: bool
    messages: list[dict]
    registry: ToolRegistry
    tools: list[Tool]
    tool_choice: object = "auto"
    max_tokens: int | None = None
    effort: str | None = None
    temperature: float | None = None
    parallel_tools: bool = True


def decode_request(protocol: str, payload: dict) -> Conversation:
    if payload.get("previous_response_id") or payload.get("conversation"):
        raise ProtocolError("跨协议连接需要完整对话历史，不能使用上游会话续接 ID。")
    registry = ToolRegistry()
    tools = []
    omitted_hosted_tools = False

    def add_tools(definitions: list, namespace: str | None = None) -> None:
        nonlocal omitted_hosted_tools
        for definition in definitions:
            kind = definition.get("type", "function")
            if kind == "namespace":
                add_tools(definition.get("tools", []), definition.get("name"))
            elif kind in {"function", "custom"} or (protocol == "anthropic" and "input_schema" in definition and not definition.get("type")):
                spec = definition.get("function", definition)
                if protocol == "anthropic":
                    # Anthropic's optional "custom" type still takes JSON.
                    # Responses custom tools instead take an unstructured string.
                    spec = {**spec, "type": "function"}
                tools.append(registry.add(spec, namespace))
            elif protocol == "responses" and kind in {"web_search", "web_search_preview"}:
                # Codex can advertise this optional hosted tool on every turn.
                # It cannot execute through a different API; keep local tools.
                omitted_hosted_tools = True
            else:
                raise ProtocolError("跨协议连接不支持上游托管工具，请选择本机工具或使用原生协议。")

    add_tools(payload.get("tools") or [])
    messages: list[dict] = []

    def message(role: str, content: object) -> None:
        if role not in {"system", "developer", "user", "assistant"}:
            raise ProtocolError("消息角色不受支持。")
        parts = _parts(content)
        if parts:
            messages.append({"role": "system" if role == "developer" else role, "content": parts})

    def call(item: dict, *, anthropic: bool = False) -> None:
        custom = item.get("type") == "custom_tool_call"
        tool = registry.source(item["name"], item.get("namespace"), custom=custom)
        arguments = item.get("input", {}) if anthropic or custom else _object(item.get("arguments", "{}"))
        if custom:
            arguments = {"input": arguments}
        messages.append({
            "role": "assistant", "content": [],
            "calls": [{"id": item.get("id") if anthropic else item.get("call_id", item.get("id")),
                       "name": tool.alias, "arguments": _json(arguments)}],
        })

    if protocol == "responses":
        if payload.get("instructions"):
            message("system", payload["instructions"])
        items = payload.get("input", [])
        if isinstance(items, str):
            message("user", items)
        else:
            for item in items:
                kind = item.get("type", "message")
                if kind == "message":
                    message(item.get("role", "user"), item.get("content"))
                elif kind in {"function_call", "custom_tool_call"}:
                    call(item)
                elif kind in {"function_call_output", "custom_tool_call_output"}:
                    output = item.get("output", "")
                    messages.append({"role": "tool", "id": item["call_id"], "content": _parts(output) if isinstance(output, (list, str)) else _parts(_json(output))})
                elif kind == "reasoning":
                    continue
                else:
                    raise ProtocolError("此对话包含无法跨协议转换的项目，请使用原生协议。")
    elif protocol == "anthropic":
        message("system", payload.get("system"))
        for entry in payload.get("messages", []):
            content = entry.get("content", [])
            if isinstance(content, str):
                message(entry["role"], content)
                continue
            for part in content:
                if part.get("type") == "tool_use":
                    call(part, anthropic=True)
                elif part.get("type") == "tool_result":
                    messages.append({"role": "tool", "id": part["tool_use_id"], "content": _parts(part.get("content")),
                                     "is_error": bool(part.get("is_error"))})
                else:
                    message(entry["role"], [part])
    else:
        for entry in payload.get("messages", []):
            if entry["role"] == "tool":
                messages.append({"role": "tool", "id": entry["tool_call_id"], "content": _parts(entry.get("content"))})
            else:
                message(entry["role"], entry.get("content"))
                for tool_call in entry.get("tool_calls") or []:
                    call({**tool_call["function"], "call_id": tool_call["id"]})
    limit = payload.get("max_output_tokens", payload.get("max_completion_tokens", payload.get("max_tokens")))
    if limit is not None and (not isinstance(limit, int) or limit < 1):
        raise ProtocolError("输出长度限制无效。")
    choice = payload.get("tool_choice", "auto")
    if isinstance(choice, dict):
        if choice.get("type") in {"any", "required"}:
            choice = "required"
        elif choice.get("type") in {"auto", "none"}:
            choice = choice["type"]
        elif choice.get("type") in {"function", "custom", "tool"}:
            spec = choice.get("function", choice)
            tool = registry.by_source.get((spec.get("namespace"), spec["name"]))
            if tool is None:
                raise ProtocolError("指定的工具无法用于当前跨协议连接。")
            choice = tool.alias
        else:
            raise ProtocolError("此工具选择方式无法跨协议转换。")
    if choice == "required" and not tools and omitted_hosted_tools:
        raise ProtocolError("此请求要求使用上游联网工具，请使用原生协议。")
    reasoning = payload.get("reasoning") or {}
    return Conversation(
        str(payload.get("model", "")), bool(payload.get("stream", False)), messages, registry, tools,
        choice, limit, reasoning.get("effort"), payload.get("temperature"),
        payload.get("parallel_tool_calls", True),
    )


def encode_request(protocol: str, conversation: Conversation) -> dict:
    c = conversation
    payload: dict = {"model": c.model, "stream": c.stream}
    if protocol == "responses":
        items = []
        for msg in c.messages:
            if msg["role"] == "tool":
                items.append({"type": "function_call_output", "call_id": msg["id"],
                              "output": _encoded_parts(msg["content"], "responses")})
            else:
                if msg["content"]:
                    items.append({"role": msg["role"], "content": _encoded_parts(msg["content"], "responses", assistant=msg["role"] == "assistant")})
                items.extend({"type": "function_call", "call_id": call["id"], "name": call["name"], "arguments": call["arguments"]}
                             for call in msg.get("calls", []))
        payload.update(input=items, store=False)
        if c.max_tokens:
            payload["max_output_tokens"] = c.max_tokens
        if c.effort:
            payload["reasoning"] = {"effort": c.effort}
        tools = [{"type": "function", "name": tool.alias, "description": tool.description, "parameters": tool.parameters} for tool in c.tools]
    elif protocol == "chat":
        messages = []
        tool_images = []
        for msg in c.messages:
            if msg["role"] != "tool" and tool_images:
                messages.append({"role": "user", "content": _encoded_parts(tool_images, "chat")})
                tool_images = []
            if msg["role"] == "tool":
                text = "\n".join(p["text"] for p in msg["content"] if p["type"] == "text")
                messages.append({"role": "tool", "tool_call_id": msg["id"], "content": text or "(image attached below)"})
                tool_images.extend(p for p in msg["content"] if p["type"] == "image")
            else:
                entry = {"role": msg["role"], "content": _encoded_parts(msg["content"], "chat") or None}
                if msg.get("calls"):
                    entry["tool_calls"] = [{"id": call["id"], "type": "function", "function": {"name": call["name"], "arguments": call["arguments"]}} for call in msg["calls"]]
                # Adjacent assistant fragments belong to the same tool turn.
                if messages and messages[-1]["role"] == entry["role"] == "assistant":
                    messages[-1]["content"] = (messages[-1]["content"] or []) + (entry["content"] or [])
                    if entry.get("tool_calls"):
                        messages[-1].setdefault("tool_calls", []).extend(entry["tool_calls"])
                else:
                    messages.append(entry)
        if tool_images:
            messages.append({"role": "user", "content": _encoded_parts(tool_images, "chat")})
        payload["messages"] = messages
        if c.max_tokens:
            payload["max_completion_tokens"] = c.max_tokens
        if c.effort and c.effort != "none":
            payload["reasoning_effort"] = {"max": "xhigh"}.get(c.effort, c.effort)
        tools = [{"type": "function", "function": {"name": tool.alias, "description": tool.description, "parameters": tool.parameters}} for tool in c.tools]
        if c.stream:
            payload["stream_options"] = {"include_usage": True}
    else:
        system, messages = [], []
        for msg in c.messages:
            if msg["role"] == "system":
                system.extend(_encoded_parts(msg["content"], "anthropic"))
                continue
            if msg["role"] == "tool":
                entry = {"role": "user", "content": [{"type": "tool_result", "tool_use_id": msg["id"],
                         "content": _encoded_parts(msg["content"], "anthropic"), "is_error": msg.get("is_error", False)}]}
            else:
                entry = {"role": msg["role"], "content": _encoded_parts(msg["content"], "anthropic")}
                entry["content"].extend({"type": "tool_use", "id": call["id"], "name": call["name"],
                                         "input": _object(call["arguments"])} for call in msg.get("calls", []))
            if messages and messages[-1]["role"] == entry["role"]:
                messages[-1]["content"].extend(entry["content"])
            else:
                messages.append(entry)
        payload.update(messages=messages, max_tokens=c.max_tokens or 16384)
        if system:
            payload["system"] = system
        tools = [{"name": tool.alias, "description": tool.description, "input_schema": tool.parameters} for tool in c.tools]
    if c.temperature is not None:
        payload["temperature"] = c.temperature
    if tools:
        payload["tools"] = tools
        choice = c.tool_choice
        if protocol == "anthropic":
            if choice != "none":
                payload["tool_choice"] = ({"type": {"required": "any", "auto": "auto"}.get(choice, "tool"),
                                          **({"name": choice} if choice not in {"required", "auto"} else {}),
                                          "disable_parallel_tool_use": not c.parallel_tools})
            else:
                payload.pop("tools", None)
        else:
            payload["tool_choice"] = choice if choice in {"auto", "none", "required"} else (
                {"type": "function", **({"name": choice} if protocol == "responses" else {"function": {"name": choice}})}
            )
            payload["parallel_tool_calls"] = c.parallel_tools
    return payload


def _usage(protocol: str, value: dict) -> dict:
    if protocol == "chat":
        return {
            "input": value.get("prompt_tokens", 0), "output": value.get("completion_tokens", 0),
            "cached": (value.get("prompt_tokens_details") or {}).get("cached_tokens", 0),
            "reasoning": (value.get("completion_tokens_details") or {}).get("reasoning_tokens", 0),
        }
    if protocol == "responses":
        return {
            "input": value.get("input_tokens", 0), "output": value.get("output_tokens", 0),
            "cached": (value.get("input_tokens_details") or {}).get("cached_tokens", 0),
            "reasoning": (value.get("output_tokens_details") or {}).get("reasoning_tokens", 0),
        }
    cached = value.get("cache_read_input_tokens", 0)
    creation = value.get("cache_creation_input_tokens", 0)
    result = {}
    if "cache_read_input_tokens" in value:
        result["cached"] = cached
    if "cache_creation_input_tokens" in value:
        result["cache_creation"] = creation
    if "input_tokens" in value:
        result["input"] = value["input_tokens"] + cached + creation
    if "output_tokens" in value:
        result["output"] = value["output_tokens"]
    return result


def sse_records(response) -> Iterator[tuple[str, dict | None]]:
    """Bounded, UTF-8-safe SSE parser; never log a provider's response body."""
    event, lines, size, total = "", [], 0, 0
    while True:
        line = response.readline(MAX_EVENT_BYTES + 1)
        if not line:
            if lines:
                raise ProtocolError("上游流式响应在事件结束前断开。")
            return
        total += len(line)
        size += len(line)
        if len(line) > MAX_EVENT_BYTES or size > MAX_EVENT_BYTES or total > MAX_RESPONSE_BYTES:
            raise ProtocolError("上游响应超过转换连接的大小限制。")
        try:
            text = line.decode("utf-8").rstrip("\r\n")
        except UnicodeError:
            raise ProtocolError("上游流式响应不是有效的 UTF-8。") from None
        if text == "":
            if lines:
                data = "\n".join(lines)
                if data == "[DONE]":
                    yield "done", None
                else:
                    try:
                        parsed = json.loads(data)
                    except ValueError:
                        raise ProtocolError("上游返回了无效的流式 JSON。") from None
                    if not isinstance(parsed, dict):
                        raise ProtocolError("上游流式响应格式不符合所选协议。")
                    yield event or parsed.get("type", ""), parsed
            event, lines, size = "", [], 0
        elif text.startswith("event:"):
            event = text[6:].lstrip(" ")
        elif text.startswith("data:"):
            lines.append(text[5:].lstrip(" "))


def _tool_event(call_id: object, name: object, arguments: str) -> dict:
    if not isinstance(call_id, str) or not call_id or not isinstance(name, str) or not name:
        raise ProtocolError("上游工具调用缺少 ID 或名称。")
    _object(arguments)
    return {"kind": "tool", "id": call_id, "name": name, "arguments": arguments}


def json_events(protocol: str, body: dict) -> Iterator[dict]:
    if body.get("error") or body.get("type") == "error":
        raise ProtocolError("上游模型返回错误，请检查模型、协议或服务状态。")
    calls = []
    if protocol == "responses":
        state = body.get("status")
        if state not in {"completed", "incomplete"}:
            raise ProtocolError("上游没有返回完整的 Responses 回复。")
        reason = (body.get("incomplete_details") or {}).get("reason")
        if state == "incomplete" and reason != "max_output_tokens":
            raise ProtocolError("上游未完成回复，请检查模型或服务状态。")
        for item in body.get("output", []):
            if item.get("type") == "message":
                for part in item.get("content", []):
                    if part.get("type") in {"output_text", "refusal"}:
                        yield {"kind": "text", "text": part.get("text", part.get("refusal", ""))}
            elif item.get("type") == "function_call":
                calls.append((item.get("call_id"), item.get("name"), item.get("arguments", "")))
        finish = "length" if state == "incomplete" else "stop"
    elif protocol == "anthropic":
        if body.get("type") != "message" or not isinstance(body.get("content"), list) or not body.get("stop_reason"):
            raise ProtocolError("上游没有返回完整的 Messages 回复。")
        for part in body["content"]:
            if part.get("type") == "text":
                yield {"kind": "text", "text": part.get("text", "")}
            elif part.get("type") == "tool_use":
                calls.append((part.get("id"), part.get("name"), _json(part.get("input", {}))))
        finish = "length" if body["stop_reason"] == "max_tokens" else "stop"
        if body["stop_reason"] not in {"end_turn", "tool_use", "stop_sequence", "max_tokens", "refusal"}:
            raise ProtocolError("上游暂停了回复或返回了无法转换的结束原因。")
    else:
        choices = body.get("choices") or []
        if not choices or not choices[0].get("finish_reason"):
            raise ProtocolError("上游没有返回完整的 Chat Completions 回复。")
        choice = choices[0]
        message = choice.get("message") or {}
        content = message.get("content")
        if content:
            for part in _parts(content):
                if part["type"] == "text":
                    yield {"kind": "text", "text": part["text"]}
        if message.get("refusal"):
            yield {"kind": "text", "text": message["refusal"]}
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            calls.append((call.get("id"), function.get("name"), function.get("arguments", "")))
        finish = "length" if choice["finish_reason"] == "length" else "stop"
        if choice["finish_reason"] == "content_filter":
            raise ProtocolError("上游回复被服务端过滤，未正常完成。")
        if choice["finish_reason"] not in {"stop", "tool_calls", "length"}:
            raise ProtocolError("上游返回了无法识别的结束原因。")
    yield {"kind": "usage", "usage": _usage(protocol, body.get("usage") or {})}
    if finish != "length":
        validated = [_tool_event(call_id, name, arguments) for call_id, name, arguments in calls]
        yield from validated
    yield {"kind": "finish", "reason": finish}


def stream_events(protocol: str, records: Iterable[tuple[str, dict | None]]) -> Iterator[dict]:
    """Text flows immediately; calls are confirmed only after a terminal event."""
    calls: dict[object, dict] = {}
    seen_text: set[object] = set()
    finish, completed = "", False
    for event, data in records:
        if event == "done":
            break
        if data is None:
            continue
        if event in {"error", "response.failed", "response.error"} or data.get("error"):
            raise ProtocolError("上游流式回复失败，请检查模型、协议或服务状态。")
        if protocol == "chat":
            if data.get("usage"):
                yield {"kind": "usage", "usage": _usage(protocol, data["usage"])}
            for choice in data.get("choices", []):
                if choice.get("index", 0) != 0:
                    continue
                delta = choice.get("delta") or {}
                text = delta.get("content") or delta.get("refusal")
                if isinstance(text, str) and text:
                    yield {"kind": "text", "text": text}
                for call in delta.get("tool_calls") or []:
                    entry = calls.setdefault(call.get("index", 0), {"id": "", "name": "", "arguments": ""})
                    function = call.get("function") or {}
                    entry["id"] += call.get("id", "")
                    entry["name"] += function.get("name", "")
                    entry["arguments"] += function.get("arguments", "")
                if choice.get("finish_reason"):
                    reason = choice["finish_reason"]
                    if reason == "content_filter":
                        raise ProtocolError("上游回复被服务端过滤，未正常完成。")
                    if reason not in {"stop", "tool_calls", "length"}:
                        raise ProtocolError("上游返回了无法识别的结束原因。")
                    finish, completed = ("length" if reason == "length" else "stop"), True
        elif protocol == "anthropic":
            if event == "message_start":
                yield {"kind": "usage", "usage": _usage(protocol, (data.get("message") or {}).get("usage") or {})}
            elif event == "content_block_start":
                part = data.get("content_block") or {}
                if part.get("type") == "tool_use":
                    calls[data["index"]] = {"id": part.get("id"), "name": part.get("name"),
                                            "arguments": "", "initial": part.get("input", {})}
                elif part.get("type") == "text" and part.get("text"):
                    yield {"kind": "text", "text": part["text"]}
            elif event == "content_block_delta":
                delta = data.get("delta") or {}
                if delta.get("type") == "text_delta":
                    yield {"kind": "text", "text": delta.get("text", "")}
                elif delta.get("type") == "input_json_delta":
                    if data.get("index") not in calls:
                        raise ProtocolError("上游工具参数顺序无效。")
                    calls[data["index"]]["arguments"] += delta.get("partial_json", "")
            elif event == "message_delta":
                reason = (data.get("delta") or {}).get("stop_reason")
                if reason:
                    if reason not in {"end_turn", "tool_use", "stop_sequence", "max_tokens", "refusal"}:
                        raise ProtocolError("上游暂停了回复或返回了无法转换的结束原因。")
                    finish = "length" if reason == "max_tokens" else "stop"
                if data.get("usage"):
                    yield {"kind": "usage", "usage": _usage(protocol, data["usage"])}
            elif event == "message_stop":
                completed = bool(finish)
                break
        else:
            if event in {"response.output_text.delta", "response.refusal.delta"}:
                key = (data.get("output_index"), data.get("content_index"))
                seen_text.add(key)
                yield {"kind": "text", "text": data.get("delta", "")}
            elif event == "response.output_item.added":
                item = data.get("item") or {}
                if item.get("type") == "function_call":
                    calls[data.get("output_index")] = {**item, "arguments": item.get("arguments", "")}
            elif event == "response.function_call_arguments.delta":
                calls.setdefault(data.get("output_index"), {"arguments": ""})["arguments"] += data.get("delta", "")
            elif event == "response.output_item.done":
                item = data.get("item") or {}
                if item.get("type") == "function_call":
                    calls[data.get("output_index")] = item
                elif item.get("type") == "message":
                    for index, part in enumerate(item.get("content", [])):
                        key = (data.get("output_index"), index)
                        if key not in seen_text and part.get("type") in {"output_text", "refusal"}:
                            seen_text.add(key)
                            yield {"kind": "text", "text": part.get("text", part.get("refusal", ""))}
            elif event in {"response.completed", "response.incomplete"}:
                response = data.get("response") or {}
                state = response.get("status", "completed" if event == "response.completed" else "incomplete")
                if state == "incomplete" and (response.get("incomplete_details") or {}).get("reason") != "max_output_tokens":
                    raise ProtocolError("上游流式回复未完成。")
                if state not in {"completed", "incomplete"}:
                    raise ProtocolError("上游流式回复未完成。")
                finish, completed = ("length" if state == "incomplete" else "stop"), True
                for index, item in enumerate(response.get("output", [])):
                    if item.get("type") == "function_call":
                        calls[index] = item
                    elif item.get("type") == "message":
                        for part_index, part in enumerate(item.get("content", [])):
                            if (index, part_index) not in seen_text and part.get("type") in {"output_text", "refusal"}:
                                yield {"kind": "text", "text": part.get("text", part.get("refusal", ""))}
                yield {"kind": "usage", "usage": _usage(protocol, response.get("usage") or {})}
                break
    if not completed:
        raise ProtocolError("上游连接在回复完成前断开，请重试。")
    if finish != "length":
        validated = []
        for entry in calls.values():
            arguments = entry.get("arguments") or _json(entry.get("initial", {}))
            call_id = entry.get("call_id", entry.get("id"))
            validated.append(_tool_event(call_id, entry.get("name"), arguments))
        yield from validated
    yield {"kind": "finish", "reason": finish}


class NativeOutput:
    """Encode a portable result in the format expected by either native CLI."""

    def __init__(self, protocol: str, conversation: Conversation) -> None:
        self.protocol = protocol
        self.conversation = conversation
        self.id = ("resp_" if protocol == "responses" else "msg_") + uuid.uuid4().hex
        self.created = int(time.time())
        self.items: list[dict] = []
        self.usage = {"input": 0, "output": 0, "cached": 0, "reasoning": 0, "cache_creation": 0}
        self.text_index: int | None = None
        self.sequence = 0
        self.reason = "stop"
        self.finished = False
        self.has_tools = False

    def _event(self, kind: str, **fields) -> dict:
        event = {"type": kind, **fields}
        if self.protocol == "responses":
            event["sequence_number"] = self.sequence
            self.sequence += 1
        return event

    def result(self, state: str = "completed") -> dict:
        usage = self.usage
        if self.protocol == "responses":
            return {
                "id": self.id, "object": "response", "created_at": self.created,
                "model": self.conversation.model, "status": state, "output": self.items,
                "error": None, "incomplete_details": {"reason": "max_output_tokens"} if state == "incomplete" else None,
                "usage": {
                    "input_tokens": usage["input"], "output_tokens": usage["output"],
                    "total_tokens": usage["input"] + usage["output"],
                    "input_tokens_details": {"cached_tokens": usage["cached"]},
                    "output_tokens_details": {"reasoning_tokens": usage["reasoning"]},
                },
            }
        return {
            "id": self.id, "type": "message", "role": "assistant", "model": self.conversation.model,
            "content": self.items, "stop_reason": (
                "max_tokens" if self.reason == "length" else "tool_use" if self.has_tools else "end_turn"
            ) if self.finished else None, "stop_sequence": None,
            "usage": {
                "input_tokens": max(0, usage["input"] - usage["cached"] - usage["cache_creation"]),
                "output_tokens": usage["output"], "cache_read_input_tokens": usage["cached"],
                "cache_creation_input_tokens": usage["cache_creation"],
            },
        }

    def start(self) -> list[dict]:
        if self.protocol == "responses":
            return [self._event("response.created", response=self.result("in_progress")),
                    self._event("response.in_progress", response=self.result("in_progress"))]
        return [self._event("message_start", message=self.result())]

    def _close_text(self) -> list[dict]:
        index = self.text_index
        if index is None:
            return []
        self.text_index = None
        item = self.items[index]
        if self.protocol == "anthropic":
            return [self._event("content_block_stop", index=index)]
        item["status"] = "completed"
        part = item["content"][0]
        return [
            self._event("response.output_text.done", item_id=item["id"], output_index=index, content_index=0, text=part["text"], logprobs=[]),
            self._event("response.content_part.done", item_id=item["id"], output_index=index, content_index=0, part=part.copy()),
            self._event("response.output_item.done", output_index=index, item={**item, "content": [part.copy()]}),
        ]

    def push(self, event: dict) -> list[dict]:
        kind = event["kind"]
        events = []
        if kind == "usage":
            self.usage.update(event["usage"])
        elif kind == "text" and event["text"]:
            if self.text_index is None:
                self.text_index = len(self.items)
                if self.protocol == "responses":
                    item = {"id": "msg_" + uuid.uuid4().hex, "type": "message", "status": "in_progress",
                            "role": "assistant", "content": []}
                    events.append(self._event("response.output_item.added", output_index=self.text_index, item={**item, "content": []}))
                    part = {"type": "output_text", "text": "", "annotations": [], "logprobs": []}
                    item["content"].append(part)
                    events.append(self._event("response.content_part.added", item_id=item["id"], output_index=self.text_index, content_index=0, part=part.copy()))
                else:
                    item = {"type": "text", "text": ""}
                    events.append(self._event("content_block_start", index=self.text_index, content_block=item.copy()))
                self.items.append(item)
            index = self.text_index
            item = self.items[index]
            if self.protocol == "responses":
                item["content"][0]["text"] += event["text"]
                events.append(self._event("response.output_text.delta", item_id=item["id"], output_index=index, content_index=0, delta=event["text"], logprobs=[]))
            else:
                item["text"] += event["text"]
                events.append(self._event("content_block_delta", index=index, delta={"type": "text_delta", "text": event["text"]}))
        elif kind == "tool":
            events.extend(self._close_text())
            tool, arguments = self.conversation.registry.decode(event["name"], event["arguments"])
            index = len(self.items)
            self.has_tools = True
            if self.protocol == "responses":
                item = {"id": "fc_" + uuid.uuid4().hex, "type": "custom_tool_call" if tool.custom else "function_call",
                        "status": "in_progress", "call_id": event["id"], "name": tool.name}
                if tool.namespace:
                    item["namespace"] = tool.namespace
                field = "input" if tool.custom else "arguments"
                value = arguments["input"] if tool.custom else event["arguments"]
                item[field] = ""
                events.append(self._event("response.output_item.added", output_index=index, item=item.copy()))
                prefix = "response.custom_tool_call_input" if tool.custom else "response.function_call_arguments"
                events.append(self._event(prefix + ".delta", item_id=item["id"], output_index=index, delta=value))
                events.append(self._event(prefix + ".done", item_id=item["id"], output_index=index, name=tool.name, **{field: value}))
                item.update({field: value, "status": "completed"})
                events.append(self._event("response.output_item.done", output_index=index, item=item.copy()))
            else:
                item = {"type": "tool_use", "id": event["id"], "name": tool.name, "input": arguments}
                events.extend([
                    self._event("content_block_start", index=index, content_block={**item, "input": {}}),
                    self._event("content_block_delta", index=index, delta={"type": "input_json_delta", "partial_json": event["arguments"]}),
                    self._event("content_block_stop", index=index),
                ])
            self.items.append(item)
        elif kind == "finish":
            events.extend(self._close_text())
            self.reason, self.finished = event["reason"], True
            if self.protocol == "responses":
                state = "incomplete" if self.reason == "length" else "completed"
                events.append(self._event("response." + state, response=self.result(state)))
            else:
                result = self.result()
                events.append(self._event("message_delta", delta={"stop_reason": result["stop_reason"], "stop_sequence": None},
                                          usage=result["usage"]))
                events.append(self._event("message_stop"))
        return events

    def failed(self, message: str) -> dict:
        if self.protocol == "responses":
            result = self.result("failed")
            result["error"] = {"code": "upstream_error", "message": message}
            return self._event("response.failed", response=result)
        return self._event("error", error={"type": "api_error", "message": message})


def sse_bytes(event: dict) -> bytes:
    return f"event: {event['type']}\ndata: {_json(event)}\n\n".encode("utf-8")
