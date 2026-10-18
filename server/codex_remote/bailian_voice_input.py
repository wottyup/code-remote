"""Bailian realtime transcription-only WebSocket support."""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import os
import socket
import ssl
import tempfile
import uuid
from contextlib import suppress
from pathlib import Path
from typing import Any


DEFAULT_REALTIME_MODEL = "fun-asr-realtime-2026-02-28"
# Retained for compatibility with older API clients; Fun-ASR uses one model field.
DEFAULT_TRANSCRIPTION_MODEL = "qwen3-asr-flash-realtime"
LEGACY_REALTIME_MODELS = {"qwen3.8-omni-flash-realtime", "qwen3-asr-flash-realtime"}
SAMPLE_RATE = 16_000
MAX_AUDIO_SECONDS = 180
MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * MAX_AUDIO_SECONDS
CLIENT_HELLO_TIMEOUT_SECONDS = 8
UPSTREAM_READY_TIMEOUT_SECONDS = 15
TRANSCRIPTION_TIMEOUT_SECONDS = 60


class BailianVoiceInputError(RuntimeError):
    """A safe-to-display configuration, protocol, or upstream error."""


def connection_error_message(error: Exception) -> str:
    response = getattr(error, "response", None)
    status_code = getattr(response, "status_code", None) or getattr(error, "status_code", None)
    if isinstance(status_code, int):
        if status_code == 401:
            return "百炼鉴权失败（HTTP 401），请检查 DashScope API Key 是否正确且有效。"
        if status_code == 403:
            return "百炼拒绝访问（HTTP 403），请检查 Workspace 授权、地域和实时模型权限。"
        if status_code == 404:
            return "百炼未找到 Workspace 或实时模型（HTTP 404），请核对 ID、地域和模型名称。"
        if status_code == 407:
            return "服务器代理认证失败（HTTP 407），请检查 HTTPS 代理配置。"
        if status_code == 429:
            return "百炼限制了连接（HTTP 429），请检查额度或并发限制后重试。"
        if status_code == 400:
            body = getattr(response, "body", None)
            if isinstance(body, bytes):
                body = body.decode("utf-8", errors="replace")
            if isinstance(body, str) and (
                "badrequest.illegalendpoint" in body.lower()
                or "workspace endpoint is invalid" in body.lower()
            ):
                return "百炼业务空间地址无效，请核对 Workspace ID 和服务地域。"
            return "百炼拒绝了实时会话配置（HTTP 400），请检查模型名称和语音模型权限。"
        if status_code >= 500:
            return f"百炼服务暂时异常（HTTP {status_code}），请稍后重试。"

    error_name = type(error).__name__.lower()
    if "proxy" in error_name:
        return "连接百炼使用的服务器代理失败，请检查 HTTPS 代理出口。"
    if isinstance(error, socket.gaierror):
        return "无法解析百炼服务器域名，请检查服务器 DNS 或网络代理。"
    if isinstance(error, ssl.SSLError):
        return "连接百炼时 TLS 验证失败，请检查系统时间、证书和 HTTPS 代理。"
    if isinstance(error, (TimeoutError, asyncio.TimeoutError)):
        return "连接百炼超时，请检查服务器外网出口、HTTPS 代理和防火墙。"
    if isinstance(error, OSError):
        return "服务器无法连接百炼，请检查外网出口、HTTPS 代理和防火墙。"
    return f"百炼连接失败（{type(error).__name__}），请检查网络、地域和配置。"


def normalize_realtime_model(model: Any) -> str:
    model = str(model or "").strip()
    if not model.startswith("fun-asr-") or model in LEGACY_REALTIME_MODELS:
        return DEFAULT_REALTIME_MODEL
    return model


def build_realtime_url(workspace_id: str, region: str, model: str) -> str:
    workspace_id = str(workspace_id or "").strip()
    region = str(region or "").strip().lower()
    model = normalize_realtime_model(model)
    if not workspace_id or not all(char.isascii() and (char.isalnum() or char in "-_") for char in workspace_id):
        raise BailianVoiceInputError("百炼 Workspace ID 无效")
    host_suffix = {
        "cn-beijing": "cn-beijing.maas.aliyuncs.com",
        "ap-southeast-1": "ap-southeast-1.maas.aliyuncs.com",
    }.get(region)
    if not host_suffix:
        raise BailianVoiceInputError("百炼地域仅支持北京或新加坡")
    if not model or not all(char.isascii() and (char.isalnum() or char in "._-") for char in model):
        raise BailianVoiceInputError("百炼实时模型名无效")
    return f"wss://{workspace_id}.{host_suffix}/api-ws/v1/inference"


def provider_error_message(event: dict[str, Any] | None = None) -> str:
    """Return actionable but credential-safe errors to the paired browser."""
    event = event if isinstance(event, dict) else {}
    code = str(event.get("error_code") or "").lower()
    message = str(event.get("error_message") or "").lower()
    header = event.get("header")
    if isinstance(header, dict):
        code = f"{code} {header.get('error_code') or ''}".lower()
        message = f"{message} {header.get('error_message') or ''}".lower()
    detail = event.get("error")
    if isinstance(detail, dict):
        code = f"{code} {detail.get('code') or ''}".lower()
        message = f"{message} {detail.get('message') or ''}".lower()
    elif detail:
        message = f"{message} {detail}".lower()
    combined = f"{code} {message}"
    if "emptyaudio" in combined or "empty_audio" in combined:
        return "未录到声音，请稍等片刻再结束录音。"
    if any(value in combined for value in ("invalid_api_key", "unauthorized", "401", "authentication")):
        return "百炼鉴权失败，请检查服务端 API Key。"
    if "illegalendpoint" in combined or "workspace endpoint is invalid" in combined:
        return "百炼业务空间地址无效，请核对 Workspace ID 和服务地域。"
    if any(value in combined for value in ("permission", "forbidden", "403", "access_denied")):
        return "百炼拒绝访问，请检查实时语音模型权限和业务空间授权。"
    if any(value in combined for value in ("workspace_not_found", "model_not_found", "404")):
        return "百炼找不到对应资源，请检查 Workspace ID、地域和模型配置。"
    return "百炼语音识别暂不可用，请检查服务端配置和网络后重试。"


class BailianVoiceInputConfig:
    def __init__(self, api_key: str, workspace_id: str, region: str, model: str):
        self.api_key = api_key.strip()
        self.workspace_id = workspace_id.strip()
        self.region = region.strip().lower()
        self.model = normalize_realtime_model(model)

    @classmethod
    def from_environment(cls) -> BailianVoiceInputConfig:
        return cls(
            api_key=os.environ.get("DASHSCOPE_API_KEY", ""),
            workspace_id=os.environ.get("BAILIAN_WORKSPACE_ID", ""),
            region=os.environ.get("BAILIAN_REGION", "cn-beijing"),
            model=os.environ.get("BAILIAN_REALTIME_MODEL", DEFAULT_REALTIME_MODEL),
        )

    def validate(self) -> None:
        if not self.api_key or not self.workspace_id:
            raise BailianVoiceInputError(
                "尚未配置百炼语音输入，请在项目设置中填写 API Key 和 Workspace ID。"
            )
        build_realtime_url(self.workspace_id, self.region, self.model)


class BailianVoiceInputSettingsStore:
    """Persist server-side provider settings without exposing the API key to clients."""

    def __init__(self, path: Path, environ: Any | None = None) -> None:
        self.path = Path(path)
        self.environ = os.environ if environ is None else environ

    def _read(self) -> dict[str, str]:
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            return {}
        if not isinstance(value, dict):
            return {}
        return {
            key: item.strip()
            for key, item in value.items()
            if key in {"api_key", "workspace_id", "region", "realtime_model"}
            and isinstance(item, str)
            and item.strip()
        }

    def _resolved(self) -> tuple[dict[str, str], str | None]:
        stored = self._read()
        env = self.environ
        values = {
            "api_key": stored.get("api_key") or str(env.get("DASHSCOPE_API_KEY", "")).strip(),
            "workspace_id": stored.get("workspace_id") or str(env.get("BAILIAN_WORKSPACE_ID", "")).strip(),
            "region": stored.get("region") or str(env.get("BAILIAN_REGION", "cn-beijing")).strip(),
            "realtime_model": normalize_realtime_model(
                stored.get("realtime_model") or env.get("BAILIAN_REALTIME_MODEL", DEFAULT_REALTIME_MODEL)
            ),
        }
        api_key_source = "project" if stored.get("api_key") else "environment" if values["api_key"] else None
        return values, api_key_source

    def get_config(self) -> BailianVoiceInputConfig:
        values, _ = self._resolved()
        return BailianVoiceInputConfig(
            values["api_key"],
            values["workspace_id"],
            values["region"],
            values["realtime_model"],
        )

    def config_for_test(self, overrides: dict[str, Any]) -> BailianVoiceInputConfig:
        current, _ = self._resolved()
        requested_key = overrides.get("api_key")
        config = BailianVoiceInputConfig(
            api_key=requested_key if isinstance(requested_key, str) and requested_key.strip() else current["api_key"],
            workspace_id=str(overrides.get("workspace_id", "")).strip(),
            region=str(overrides.get("region", "cn-beijing")).strip(),
            model=normalize_realtime_model(overrides.get("realtime_model", DEFAULT_REALTIME_MODEL)),
        )
        config.validate()
        return config

    def public_view(self) -> dict[str, Any]:
        values, api_key_source = self._resolved()
        return {
            "configured": bool(values["api_key"] and values["workspace_id"]),
            "api_key_configured": bool(values["api_key"]),
            "api_key_source": api_key_source,
            "project_settings_saved": self.path.is_file(),
            "workspace_id": values["workspace_id"],
            "region": values["region"],
            "realtime_model": values["realtime_model"],
        }

    def update(self, values: dict[str, Any]) -> dict[str, Any]:
        stored = self._read()
        api_key = values.get("api_key")
        if api_key is not None and not isinstance(api_key, str):
            raise BailianVoiceInputError("API Key 格式无效")
        if isinstance(api_key, str) and api_key.strip():
            stored["api_key"] = api_key.strip()

        workspace_id = str(values.get("workspace_id", "")).strip()
        region = str(values.get("region", "cn-beijing")).strip().lower()
        realtime_model = normalize_realtime_model(values.get("realtime_model", DEFAULT_REALTIME_MODEL))
        build_realtime_url(workspace_id, region, realtime_model)

        stored.update({
            "workspace_id": workspace_id,
            "region": region,
            "realtime_model": realtime_model,
        })
        self._write(stored)
        return self.public_view()

    def reset(self) -> dict[str, Any]:
        with suppress(FileNotFoundError):
            self.path.unlink()
        return self.public_view()

    def _write(self, values: dict[str, str]) -> None:
        try:
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            descriptor, temporary_path = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent,
            )
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as settings_file:
                    json.dump(values, settings_file, ensure_ascii=False)
                    settings_file.write("\n")
                    settings_file.flush()
                    os.fsync(settings_file.fileno())
                os.replace(temporary_path, self.path)
                os.chmod(self.path, 0o600)
            except Exception:
                with suppress(FileNotFoundError):
                    os.unlink(temporary_path)
                raise
        except OSError as error:
            raise BailianVoiceInputError("无法安全保存百炼配置，请检查服务目录权限。") from error


def provider_event_type(event: dict[str, Any]) -> str:
    header = event.get("header")
    if isinstance(header, dict) and header.get("event"):
        return str(header["event"])
    return str(event.get("type") or event.get("event") or "")


class BailianVoiceInputSession:
    """One Bailian realtime connection used only to transcribe microphone audio."""

    def __init__(self, config: BailianVoiceInputConfig, *, websocket_connect=None):
        self.config = config
        self._websocket_connect = websocket_connect
        self._websocket = None
        self._closed = False
        self.task_id = str(uuid.uuid4())

    async def connect(self) -> None:
        self.config.validate()
        connector = self._websocket_connect
        if connector is None:
            try:
                import websockets
            except ImportError as exc:  # pragma: no cover - dependency is declared in requirements.txt
                raise BailianVoiceInputError("缺少 websockets 依赖，请安装 server/requirements.txt") from exc
            connector = websockets.connect

        try:
            try:
                parameters = inspect.signature(connector).parameters
                header_name = "additional_headers" if "additional_headers" in parameters else "extra_headers"
            except (TypeError, ValueError):
                header_name = "additional_headers"
            self._websocket = await connector(
                build_realtime_url(self.config.workspace_id, self.config.region, self.config.model),
                **{
                    header_name: {
                        "Authorization": f"Bearer {self.config.api_key}",
                        "X-DashScope-WorkSpace": self.config.workspace_id,
                    },
                    "user_agent_header": "codex-remote",
                    "open_timeout": 12,
                    "close_timeout": 2,
                    "ping_interval": 20,
                    "ping_timeout": 20,
                    "max_size": 4 * 1024 * 1024,
                },
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise BailianVoiceInputError(connection_error_message(exc)) from exc

    async def configure(self) -> None:
        await self.send_json({
            "header": {
                "action": "run-task",
                "task_id": self.task_id,
                "streaming": "duplex",
            },
            "payload": {
                "task_group": "audio",
                "task": "asr",
                "function": "recognition",
                "model": self.config.model,
                "parameters": {"format": "pcm", "sample_rate": SAMPLE_RATE},
                "input": {},
            },
        })

    async def send_audio(self, pcm16: bytes) -> None:
        if not pcm16:
            return
        if self._websocket is None or self._closed:
            raise BailianVoiceInputError("百炼语音识别连接尚未就绪")
        try:
            await self._websocket.send(pcm16)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise BailianVoiceInputError("与百炼通信失败，请检查网络后重试。") from exc

    async def commit(self) -> None:
        await self.send_json({
            "header": {
                "action": "finish-task",
                "task_id": self.task_id,
                "streaming": "duplex",
            },
            "payload": {"input": {}},
        })

    async def receive_event(self) -> dict[str, Any]:
        if self._websocket is None or self._closed:
            raise BailianVoiceInputError("百炼语音识别连接已关闭")
        try:
            raw = await self._websocket.recv()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if self._closed:
                raise BailianVoiceInputError("百炼语音识别连接已关闭") from exc
            raise BailianVoiceInputError("百炼语音识别连接中断，请重试。") from exc
        try:
            event = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
        except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as exc:
            raise BailianVoiceInputError("百炼返回了无法识别的语音事件") from exc
        if not isinstance(event, dict):
            raise BailianVoiceInputError("百炼返回了无效语音事件")
        return event

    async def send_json(self, event: dict[str, Any]) -> None:
        if self._websocket is None or self._closed:
            raise BailianVoiceInputError("百炼语音识别连接尚未就绪")
        try:
            await self._websocket.send(json.dumps(event, ensure_ascii=False))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise BailianVoiceInputError("与百炼通信失败，请检查网络后重试。") from exc

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        websocket, self._websocket = self._websocket, None
        if websocket is not None:
            with suppress(Exception):
                await websocket.close()


async def receive_expected_event(
    session: BailianVoiceInputSession,
    expected: str,
    timeout_message: str = "等待百炼语音识别会话就绪超时，请检查模型权限和配置。",
) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + UPSTREAM_READY_TIMEOUT_SECONDS
    while True:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise BailianVoiceInputError(timeout_message)
        try:
            event = await asyncio.wait_for(session.receive_event(), timeout=remaining)
        except asyncio.TimeoutError as exc:
            raise BailianVoiceInputError(timeout_message) from exc
        event_type = provider_event_type(event)
        if event_type == "task-failed" or event_type == "error":
            raise BailianVoiceInputError(provider_error_message(event))
        if event_type == expected:
            return event


async def test_bailian_voice_connection(
    config: BailianVoiceInputConfig,
    *,
    websocket_connect=None,
) -> None:
    """Validate credentials and a Fun-ASR task without sending audio."""
    session = BailianVoiceInputSession(config, websocket_connect=websocket_connect)
    try:
        await session.connect()
        await session.configure()
        await receive_expected_event(session, "task-started")
    finally:
        await session.close()


async def run_voice_input_websocket(
    websocket: Any,
    auth: Any,
    config_provider: Any | None = None,
) -> None:
    """Authenticate a browser, proxy PCM frames to Bailian, and relay only ASR."""
    await websocket.accept()
    try:
        hello = await asyncio.wait_for(websocket.receive_json(), timeout=CLIENT_HELLO_TIMEOUT_SECONDS)
    except asyncio.CancelledError:
        raise
    except Exception:
        with suppress(Exception):
            await websocket.close(code=1008, reason="client hello required")
        return
    if (
        not isinstance(hello, dict)
        or hello.get("type") != "voice.transcription.hello"
        or hello.get("protocol_version") != 1
        or not isinstance(hello.get("token"), str)
        or not auth.accepts(hello.get("token"))
    ):
        with suppress(Exception):
            await websocket.close(code=1008, reason="invalid pairing token or protocol")
        return

    config = config_provider() if config_provider is not None else BailianVoiceInputConfig.from_environment()
    session = BailianVoiceInputSession(config)
    client_task: asyncio.Task | None = None
    provider_task: asyncio.Task | None = None
    try:
        await session.connect()
        await session.configure()
        await receive_expected_event(session, "task-started")
        await websocket.send_json({"type": "voice.transcription.ready"})

        audio_bytes_received = 0
        committed = False
        sentence_texts: dict[int, str] = {}
        client_task = asyncio.create_task(websocket.receive())
        provider_task = asyncio.create_task(session.receive_event())
        while True:
            done, _ = await asyncio.wait(
                {client_task, provider_task},
                timeout=TRANSCRIPTION_TIMEOUT_SECONDS if committed else None,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                await websocket.send_json({
                    "type": "voice.transcription.error",
                    "message": "等待百炼转写超时，请重试。",
                })
                return

            if provider_task in done:
                try:
                    event = provider_task.result()
                except BailianVoiceInputError as exc:
                    await websocket.send_json({"type": "voice.transcription.error", "message": str(exc)})
                    return
                event_type = provider_event_type(event)
                if event_type in {"error", "task-failed"}:
                    await websocket.send_json({
                        "type": "voice.transcription.error",
                        "message": provider_error_message(event),
                    })
                    return
                if event_type == "result-generated":
                    payload = event.get("payload")
                    output = payload.get("output") if isinstance(payload, dict) else None
                    sentence = output.get("sentence") if isinstance(output, dict) else None
                    if isinstance(sentence, dict) and not sentence.get("heartbeat"):
                        text = str(sentence.get("text") or "")
                        if text:
                            try:
                                sentence_id = int(sentence.get("sentence_id"))
                            except (TypeError, ValueError):
                                sentence_id = max(sentence_texts, default=0) + 1
                            sentence_texts[sentence_id] = text
                            partial_text = "".join(
                                sentence_texts[key] for key in sorted(sentence_texts)
                            )
                            await websocket.send_json({
                                "type": "voice.transcription.partial",
                                "text": partial_text,
                            })
                elif event_type == "task-finished":
                    transcript = "".join(
                        sentence_texts[key] for key in sorted(sentence_texts)
                    ).strip()
                    await websocket.send_json({
                        "type": "voice.transcription.completed",
                        "text": transcript,
                    })
                    return
                provider_task = asyncio.create_task(session.receive_event())

            if client_task in done:
                try:
                    message = client_task.result()
                except Exception:
                    return
                if message.get("type") == "websocket.disconnect":
                    return
                audio = message.get("bytes")
                if audio is not None:
                    if committed:
                        await websocket.send_json({
                            "type": "voice.transcription.error",
                            "message": "音频已提交，请重新开始录音。",
                        })
                        return
                    audio_bytes_received += len(audio)
                    if audio_bytes_received > MAX_AUDIO_BYTES:
                        await websocket.send_json({
                            "type": "voice.transcription.error",
                            "message": "单次语音不能超过 3 分钟。",
                        })
                        return
                    await session.send_audio(audio)
                else:
                    text = message.get("text")
                    if text is not None:
                        try:
                            control = json.loads(text)
                        except (TypeError, json.JSONDecodeError):
                            await websocket.send_json({
                                "type": "voice.transcription.error",
                                "message": "语音输入控制消息无效。",
                            })
                            return
                        if not isinstance(control, dict):
                            return
                        if control.get("type") == "voice.transcription.commit":
                            if not committed:
                                committed = True
                                await session.commit()
                        elif control.get("type") == "voice.transcription.cancel":
                            await websocket.send_json({"type": "voice.transcription.cancelled"})
                            return
                        elif control.get("type") == "voice.transcription.ping":
                            await websocket.send_json({"type": "voice.transcription.pong"})
                        else:
                            await websocket.send_json({
                                "type": "voice.transcription.error",
                                "message": "不支持的语音输入控制消息。",
                            })
                            return
                client_task = asyncio.create_task(websocket.receive())
    except asyncio.CancelledError:
        raise
    except BailianVoiceInputError as exc:
        with suppress(Exception):
            await websocket.send_json({"type": "voice.transcription.error", "message": str(exc)})
    except Exception:
        with suppress(Exception):
            await websocket.send_json({
                "type": "voice.transcription.error",
                "message": "百炼语音输入暂时失败，请稍后重试。",
            })
    finally:
        for task in (client_task, provider_task):
            if task is not None and not task.done():
                task.cancel()
        pending = [task for task in (client_task, provider_task) if task is not None]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        await session.close()
        with suppress(Exception):
            await websocket.close()
