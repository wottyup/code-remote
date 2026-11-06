"""Authenticated loopback adapter with immutable, private connection snapshots."""

from __future__ import annotations

import asyncio
import copy
import hmac
import ipaddress
import json
import re
import secrets
from collections import OrderedDict
from collections.abc import Iterator
from http.client import HTTPException as HTTPTransportError
from pathlib import Path
from time import monotonic
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request as UpstreamRequest, build_opener

from fastapi import Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from .native_engine_config import NATIVE_PROTOCOLS, NativeEngineConfigError, NativeEngineConfigStore
from .native_engine_protocol import (
    MAX_RESPONSE_BYTES, PROTOCOLS, Conversation, ImageInputError, NativeOutput, ProtocolError, api_endpoint,
    decode_request, encode_request, json_events, sse_bytes, sse_records, stream_events, text_only_history,
)

MAX_REQUEST_BYTES = 64 * 1024 * 1024
SNAPSHOT_FIELDS = ("baseUrl", "apiKey", "authMode", "protocol", "model", "models")
IMAGE_CAPABILITY_CACHE_SECONDS = 300
MAX_IMAGE_CAPABILITY_ENTRIES = 128


class _UpstreamRejection(Exception):
    """Keep only safe classifications, never the provider's error body."""

    def __init__(self, error: HTTPError) -> None:
        super().__init__("Upstream rejected the request")
        self.code = error.code
        fields = {}
        try:
            raw = error.read(16 * 1024 + 1)
            if len(raw) <= 16 * 1024:
                body = json.loads(raw)
                if isinstance(body, dict):
                    detail = body.get("error", body.get("detail", body))
                    if isinstance(detail, str):
                        fields = {"message": detail}
                    elif isinstance(detail, dict):
                        fields = {key: value for key, value in detail.items()
                                  if key in {"message", "type", "code", "param"} and isinstance(value, str)}
        except (ValueError, UnicodeError, OSError, HTTPTransportError):
            pass
        finally:
            error.close()
        message = " ".join(fields.values()).casefold()
        code = fields.get("code", "").casefold()
        invalid_image = re.search(
            r"(?:invalid|malformed|corrupt) (?:image|base64)|image (?:format|type|size|dimensions|resolution|encoding)|media.?type|mime|download|fetch|图片格式|图像格式|图片大小|图片下载",
            message,
        )
        image_term = r"(?:images?|image_urls?|image[_ -]?inputs?|vision|multimodal)"
        image_rejection = re.search(
            rf"\b(?:does not support|doesn't support|do not support|unsupported|no support for)\s+(?:[\w-]+[ :]+){{0,3}}['\"]?{image_term}\b"
            rf"|\b{image_term}['\"]?(?:\s+(?:inputs?|content|requests?|messages?))?\s+(?:(?:is|are)\s+)?(?:not supported|unsupported|not allowed|disabled)\b"
            r"|(?:model|endpoint|api|messages?|content|input).{0,64}(?:only supports?|supports? only|only accepts?|accepts? only|must contain only)\s+(?:plain\s+)?text\b"
            r"|only\s+(?:plain\s+)?['\"]?text['\"]?(?:\s+\w+){0,3}\s+(?:is|are)\s+(?:supported|accepted|allowed)"
            r"|(?:不支持|不接受|无法处理).{0,8}(?:图片|图像|视觉|多模态)|(?:图片|图像|视觉|多模态).{0,8}(?:不支持|不接受)",
            message,
        )
        text_content_only = ("image_url" in message and re.search(
            r"supported (?:values|types)(?: are)?[:=]\s*(?:\[\s*)?['\"]text['\"]\s*(?:\]|[.。]|$)", message,
        ))
        self.rejects_images = not invalid_image and bool(image_rejection or text_content_only or code in {
            "image_not_supported", "image_input_not_supported", "model_does_not_support_images",
            "vision_not_supported", "unsupported_multimodal",
        })
        self.rejects_token_limit = "max_completion_tokens" in message and bool(re.search(
            r"unsupported|not supported|unknown|unrecognized|not allowed|not permitted|use\s+['\"]?max_tokens",
            message,
        ))


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class NativeEngineGateway:
    def __init__(self, directory: Path, native: NativeEngineConfigStore, base_url: str) -> None:
        self.directory = directory / "native-engine-gateway"
        self.native = native
        self.base_url = base_url.rstrip("/")
        self.slots = asyncio.Semaphore(16)
        self._text_only_models: OrderedDict[tuple[str, str], float] = OrderedDict()

    def _snapshot(self, engine: str, connection_id: str) -> dict:
        if engine not in NATIVE_PROTOCOLS or not re.fullmatch(r"[a-f0-9]{32}", connection_id):
            raise NativeEngineConfigError("本机转换连接不存在。")
        data = self.native._read_bytes(self.directory / f"{connection_id}.json")
        try:
            record = json.loads(data or b"null")
            if (not isinstance(record, dict) or record.get("version") != 1 or record.get("engine") != engine
                    or not isinstance(record.get("token"), str) or not record["token"]
                    or not isinstance(record.get("profile"), dict)
                    or record["profile"].get("protocol") not in PROTOCOLS):
                raise ValueError()
            profile = record["profile"]
            if (not all(isinstance(profile.get(key), str) for key in SNAPSHOT_FIELDS if key != "models")
                    or not isinstance(profile.get("models"), dict)
                    or profile["authMode"] not in {"bearer", "api_key"}):
                raise ValueError()
            return record
        except (ValueError, TypeError, UnicodeError):
            raise NativeEngineConfigError("本机转换连接无效，请重新应用接口配置。") from None

    def _base(self, engine: str, connection_id: str) -> str:
        return f"{self.base_url}/native-api/{engine}/{connection_id}" + ("/v1" if engine == "codex" else "")

    def restore(self, engine: str, source: dict) -> dict:
        """Resolve a managed native URL without exposing its proxy credentials."""
        url = urlsplit(source["baseUrl"])
        match = re.fullmatch(rf"/native-api/{engine}/([a-f0-9]{{32}})(?:/v1)?", url.path)
        if url.hostname not in {"127.0.0.1", "::1", "localhost"} or not match:
            return source
        record = self._snapshot(engine, match[1])
        if not hmac.compare_digest(source["apiKey"].encode(), record["token"].encode()):
            raise NativeEngineConfigError("本机转换连接凭据不匹配，请重新应用接口配置。")
        # Native file revisions and actual model selections remain authoritative.
        return {
            **source, **{key: copy.deepcopy(record["profile"][key]) for key in ("baseUrl", "apiKey", "authMode", "protocol")},
            "hasKey": bool(record["profile"]["apiKey"]), "viaGateway": True,
            "_gatewayId": match[1], "_gatewayBase": source["baseUrl"],
        }

    def prepare(self, engine: str, profile: dict, source: dict) -> dict:
        if profile["protocol"] == NATIVE_PROTOCOLS[engine] and not (engine == "codex" and profile["authMode"] != "bearer"):
            return {key: profile[key] for key in ("baseUrl", "apiKey", "authMode")}
        connection_id = source.get("_gatewayId")
        if connection_id and source.get("_gatewayBase") == self._base(engine, connection_id):
            record = self._snapshot(engine, connection_id)
            if all(record["profile"].get(key) == profile.get(key) for key in SNAPSHOT_FIELDS):
                return {"baseUrl": self._base(engine, connection_id), "apiKey": record["token"], "authMode": "bearer"}
        connection_id, token = secrets.token_hex(16), secrets.token_urlsafe(36)
        record = {"version": 1, "engine": engine, "token": token,
                  "profile": {key: copy.deepcopy(profile[key]) for key in SNAPSHOT_FIELDS}}
        path = self.directory / f"{connection_id}.json"
        self.native.atomic_write(path, (json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode(),
                                 self.native._revision(path, None))
        return {"baseUrl": self._base(engine, connection_id), "apiKey": token, "authMode": "bearer",
                "_newSnapshot": connection_id}

    def discard_prepared(self, prepared: dict) -> None:
        connection_id = prepared.get("_newSnapshot")
        if connection_id:
            try:
                (self.directory / f"{connection_id}.json").unlink(missing_ok=True)
            except OSError:
                pass

    def _authenticate(self, engine: str, connection_id: str, request: Request) -> dict | None:
        try:
            host = ipaddress.ip_address(request.client.host if request.client else "")
            if not (host.is_loopback or (isinstance(host, ipaddress.IPv6Address) and host.ipv4_mapped and host.ipv4_mapped.is_loopback)):
                return None
            record = self._snapshot(engine, connection_id)
        except (ValueError, NativeEngineConfigError, OSError):
            return None
        token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        if not hmac.compare_digest(token.encode(), record["token"].encode()):
            return None
        return record["profile"]

    @staticmethod
    def _error(protocol: str, message: str, code: int) -> JSONResponse:
        error = {"type": "api_error", "message": message}
        body = {"type": "error", "error": error} if protocol == "anthropic" else {"error": error}
        return JSONResponse(body, status_code=code, headers={"Cache-Control": "no-store"})

    @staticmethod
    def _open(profile: dict, payload: dict, request: Request, *, passthrough: bool, count: bool):
        headers = {"Content-Type": "application/json", "Accept": "text/event-stream" if payload.get("stream") else "application/json",
                   "Accept-Encoding": "identity", "User-Agent": "CodeRemote/1.0"}
        key = profile["apiKey"]
        headers["x-api-key" if profile["authMode"] == "api_key" else "Authorization"] = (
            key if profile["authMode"] == "api_key" else f"Bearer {key}"
        )
        if profile["protocol"] == "anthropic":
            headers["anthropic-version"] = request.headers.get("anthropic-version", "2023-06-01")
            if passthrough and request.headers.get("anthropic-beta"):
                headers["anthropic-beta"] = request.headers["anthropic-beta"]
        endpoint = api_endpoint(profile) + ("/count_tokens" if count else "")
        opener = build_opener(_NoRedirect())

        def send(data: dict):
            upstream = UpstreamRequest(endpoint, data=json.dumps(data, ensure_ascii=False, allow_nan=False).encode(),
                                       headers=headers, method="POST")
            try:
                return opener.open(upstream, timeout=90)
            except HTTPError as error:
                raise _UpstreamRejection(error) from None

        try:
            return send(payload)
        except _UpstreamRejection as error:
            if (profile["protocol"] != "chat" or error.code != 400 or "max_completion_tokens" not in payload
                    or not error.rejects_token_limit):
                raise
            # Older Chat-compatible services implement the original limit name.
            legacy = {key: value for key, value in payload.items() if key != "max_completion_tokens"}
            legacy["max_tokens"] = payload["max_completion_tokens"]
            return send(legacy)

    async def _connect(self, connection_id: str, profile: dict, payload: dict, request: Request,
                       conversation: Conversation | None, *, passthrough: bool, count: bool):
        # Cache access stays on the event loop; only network I/O runs in threads.
        if conversation is None or not any(
            part["type"] == "image" for message in conversation.messages for part in message["content"]
        ):
            response = await asyncio.to_thread(self._open, profile, payload, request, passthrough=passthrough, count=count)
            return response, ""
        key = (connection_id, conversation.model)
        notice, used_text_fallback = "", False
        rejected_at = self._text_only_models.get(key)
        if rejected_at is not None and monotonic() - rejected_at >= IMAGE_CAPABILITY_CACHE_SECONDS:
            self._text_only_models.pop(key, None)
            rejected_at = None
        if rejected_at is not None:
            self._text_only_models.move_to_end(key)
            text_conversation, notice = text_only_history(conversation)
            payload = encode_request(profile["protocol"], text_conversation)
            used_text_fallback = True
        try:
            response = await asyncio.to_thread(self._open, profile, payload, request, passthrough=passthrough, count=count)
        except _UpstreamRejection as error:
            if used_text_fallback or error.code not in {400, 415, 422} or not error.rejects_images:
                raise
            self._text_only_models[key] = monotonic()
            self._text_only_models.move_to_end(key)
            while len(self._text_only_models) > MAX_IMAGE_CAPABILITY_ENTRIES:
                self._text_only_models.popitem(last=False)
            text_conversation, notice = text_only_history(conversation)
            payload = encode_request(profile["protocol"], text_conversation)
            response = await asyncio.to_thread(self._open, profile, payload, request, passthrough=False, count=False)
        return response, notice

    @staticmethod
    def _body(response) -> dict:
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ProtocolError("上游回复超过转换连接的大小限制。")
        try:
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError()
        except (ValueError, UnicodeError):
            raise ProtocolError("上游没有返回有效的 JSON，请检查接口协议和地址。") from None
        return data

    @staticmethod
    def _converted(response, upstream_protocol: str, output: NativeOutput) -> Iterator[bytes]:
        try:
            content_type = response.headers.get("Content-Type", "").lower()
            events = stream_events(upstream_protocol, sse_records(response)) if "text/event-stream" in content_type else (
                json_events(upstream_protocol, NativeEngineGateway._body(response))
            )
            started, pending_calls = False, []
            for event in events:
                if not started and event["kind"] != "usage":
                    for encoded in output.start():
                        yield sse_bytes(encoded)
                    started = True
                if event["kind"] == "tool":
                    output.conversation.registry.decode(event["name"], event["arguments"])
                    pending_calls.append(event)
                    continue
                if event["kind"] == "finish":
                    for call in pending_calls:
                        for encoded in output.push(call):
                            yield sse_bytes(encoded)
                for encoded in output.push(event):
                    yield sse_bytes(encoded)
        except (ProtocolError, HTTPTransportError, OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
            # Never echo provider response bodies or socket/URL exceptions.
            yield sse_bytes(output.failed("接口回复中断或格式无效，请检查所选协议、模型和上游服务。"))

    @staticmethod
    def _raw(response) -> Iterator[bytes]:
        total = 0
        while True:
            chunk = response.read1(64 * 1024)
            if not chunk:
                return
            total += len(chunk)
            if total > MAX_RESPONSE_BYTES:
                return
            yield chunk

    async def handle(self, engine: str, connection_id: str, endpoint: str, request: Request):
        native_protocol = NATIVE_PROTOCOLS.get(engine, "responses")
        profile = await asyncio.to_thread(self._authenticate, engine, connection_id, request)
        if profile is None:
            return self._error(native_protocol, "本机转换连接未授权。", 401)
        count = endpoint == "messages/count_tokens"
        if endpoint != ("responses" if native_protocol == "responses" else "messages") and not (native_protocol == "anthropic" and count):
            return self._error(native_protocol, "此转换连接不支持该接口。", 404)
        passthrough = profile["protocol"] == native_protocol
        if count and not passthrough:
            return self._error(native_protocol, "所选上游没有兼容的精确 Token 计数接口。", 501)
        try:
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > MAX_REQUEST_BYTES:
                    return self._error(native_protocol, "请求超过 64 MB，请减少图片或对话内容。", 413)
            payload = json.loads(body)
            if not isinstance(payload, dict):
                raise ValueError()
            conversation = None
            if not passthrough:
                conversation = decode_request(native_protocol, payload)
                conversation.model = profile.get("models", {}).get(conversation.model, {}).get("model") or conversation.model
                if not conversation.model:
                    raise ProtocolError("请在配置中填写实际请求模型。")
                payload = encode_request(profile["protocol"], conversation)
        except ProtocolError as error:
            return self._error(native_protocol, str(error), 400)
        except (ValueError, TypeError, KeyError, AttributeError, UnicodeError, RecursionError):
            return self._error(native_protocol, "请求内容无效或包含无法转换的消息格式。", 400)
        try:
            await asyncio.wait_for(self.slots.acquire(), timeout=5)
        except TimeoutError:
            return self._error(native_protocol, "本机转换请求过多，请稍后重试。", 429)
        response = None
        cleaned = False

        async def cleanup() -> None:
            nonlocal cleaned
            if cleaned:
                return
            cleaned = True
            self.slots.release()
            if response is not None:
                await asyncio.to_thread(response.close)

        try:
            response, notice = await self._connect(connection_id, profile, payload, request, conversation,
                                                   passthrough=passthrough, count=count)
            if not payload.get("stream"):
                data = await asyncio.to_thread(self._body, response)
                if not passthrough:
                    output = NativeOutput(native_protocol, conversation, notice=notice)
                    for event in json_events(profile["protocol"], data):
                        output.push(event)
                    data = output.result("incomplete" if output.reason == "length" else "completed")
                await cleanup()
                return JSONResponse(data, headers={"Cache-Control": "no-store"})
            chunks = self._raw(response) if passthrough else self._converted(
                response, profile["protocol"], NativeOutput(native_protocol, conversation, notice=notice),
            )

            def next_chunk() -> bytes | None:
                try:
                    return next(chunks)
                except StopIteration:
                    return None

            async def stream():
                try:
                    while True:
                        chunk = await asyncio.to_thread(next_chunk)
                        if chunk is None:
                            return
                        yield chunk
                finally:
                    await cleanup()

            return StreamingResponse(stream(), media_type="text/event-stream",
                                     headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no", "Content-Encoding": "identity"},
                                     background=BackgroundTask(cleanup))
        except _UpstreamRejection as error:
            code = error.code
            await cleanup()
            message = {
                400: "上游拒绝请求，请检查模型及其工具、图片和参数支持情况。",
                401: "上游认证失败，请检查密钥和密钥传递方式。",
                403: "上游拒绝访问，请检查接口权限。",
                404: "上游接口或模型不存在，请检查地址、协议和模型名称。",
                429: "上游限流或额度不足，请稍后重试。",
            }.get(code, "上游接口请求失败，请检查地址和服务状态。")
            return self._error(native_protocol, message, code if 400 <= code < 600 else 502)
        except ImageInputError as error:
            await cleanup()
            return self._error(native_protocol, str(error), 400)
        except ProtocolError as error:
            await cleanup()
            return self._error(native_protocol, str(error), 502)
        except asyncio.CancelledError:
            await cleanup()
            raise
        except (HTTPTransportError, URLError, OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
            await cleanup()
            return self._error(native_protocol, "无法连接上游或响应格式无效，请检查网络、协议和地址。", 502)
