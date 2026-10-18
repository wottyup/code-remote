"""Bailian realtime transcription-only WebSocket support."""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import os
import tempfile
from contextlib import suppress
from pathlib import Path
from typing import Any
from urllib.parse import quote


DEFAULT_REALTIME_MODEL = "qwen3.8-omni-flash-realtime"
DEFAULT_TRANSCRIPTION_MODEL = "qwen3-asr-flash-realtime"
SAMPLE_RATE = 16_000
MAX_AUDIO_SECONDS = 180
MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * MAX_AUDIO_SECONDS
CLIENT_HELLO_TIMEOUT_SECONDS = 8
UPSTREAM_READY_TIMEOUT_SECONDS = 15
TRANSCRIPTION_TIMEOUT_SECONDS = 60


class BailianVoiceInputError(RuntimeError):
    """A safe-to-display configuration, protocol, or upstream error."""


def build_realtime_url(workspace_id: str, region: str, model: str) -> str:
    workspace_id = str(workspace_id or "").strip()
    region = str(region or "").strip().lower()
    model = str(model or "").strip()
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
    return f"wss://{workspace_id}.{host_suffix}/api-ws/v1/realtime?model={quote(model, safe='._-')}"


def provider_error_message(event: dict[str, Any] | None = None) -> str:
    """Return actionable but credential-safe errors to the paired browser."""
    detail = event.get("error") if isinstance(event, dict) else None
    if isinstance(detail, dict):
        code = str(detail.get("code") or "").lower()
        message = str(detail.get("message") or "").lower()
    else:
        code = ""
        message = str(detail or "").lower()
    combined = f"{code} {message}"
    if any(value in combined for value in ("invalid_api_key", "unauthorized", "401", "authentication")):
        return "百炼鉴权失败，请检查服务端 API Key。"
    if any(value in combined for value in ("permission", "forbidden", "403", "access_denied")):
        return "百炼拒绝访问，请检查实时语音模型权限和业务空间授权。"
    if any(value in combined for value in ("workspace_not_found", "model_not_found", "404")):
        return "百炼找不到对应资源，请检查 Workspace ID、地域和模型配置。"
    return "百炼语音识别暂不可用，请检查服务端配置和网络后重试。"


class BailianVoiceInputConfig:
    def __init__(self, api_key: str, workspace_id: str, region: str, model: str, transcription_model: str):
        self.api_key = api_key.strip()
        self.workspace_id = workspace_id.strip()
        self.region = region.strip().lower()
        self.model = model.strip()
        self.transcription_model = transcription_model.strip()

    @classmethod
    def from_environment(cls) -> BailianVoiceInputConfig:
        return cls(
            api_key=os.environ.get("DASHSCOPE_API_KEY", ""),
            workspace_id=os.environ.get("BAILIAN_WORKSPACE_ID", ""),
            region=os.environ.get("BAILIAN_REGION", "cn-beijing"),
            model=os.environ.get("BAILIAN_REALTIME_MODEL", DEFAULT_REALTIME_MODEL),
            transcription_model=os.environ.get("BAILIAN_TRANSCRIPTION_MODEL", DEFAULT_TRANSCRIPTION_MODEL),
        )

    def validate(self) -> None:
        if not self.api_key or not self.workspace_id:
            raise BailianVoiceInputError(
                "尚未配置百炼语音输入，请在项目设置中填写 API Key 和 Workspace ID。"
            )
        build_realtime_url(self.workspace_id, self.region, self.model)
        if not self.transcription_model:
            raise BailianVoiceInputError("百炼转写模型配置无效")


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
            if key in {"api_key", "workspace_id", "region", "realtime_model", "transcription_model"}
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
            "realtime_model": stored.get("realtime_model") or str(env.get("BAILIAN_REALTIME_MODEL", DEFAULT_REALTIME_MODEL)).strip(),
            "transcription_model": stored.get("transcription_model") or str(env.get("BAILIAN_TRANSCRIPTION_MODEL", DEFAULT_TRANSCRIPTION_MODEL)).strip(),
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
            values["transcription_model"],
        )

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
            "transcription_model": values["transcription_model"],
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
        realtime_model = str(values.get("realtime_model", DEFAULT_REALTIME_MODEL)).strip()
        transcription_model = str(values.get("transcription_model", DEFAULT_TRANSCRIPTION_MODEL)).strip()
        build_realtime_url(workspace_id, region, realtime_model)
        if not transcription_model or not all(
            char.isascii() and (char.isalnum() or char in "._-") for char in transcription_model
        ):
            raise BailianVoiceInputError("百炼转写模型名无效")

        stored.update({
            "workspace_id": workspace_id,
            "region": region,
            "realtime_model": realtime_model,
            "transcription_model": transcription_model,
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


class BailianVoiceInputSession:
    """One Bailian realtime connection used only to transcribe microphone audio."""

    def __init__(self, config: BailianVoiceInputConfig, *, websocket_connect=None):
        self.config = config
        self._websocket_connect = websocket_connect
        self._websocket = None
        self._closed = False

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
                    header_name: {"Authorization": f"Bearer {self.config.api_key}"},
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
            raise BailianVoiceInputError("连接百炼失败，请检查服务端网络、地域和配置。") from exc

    async def configure(self) -> None:
        await self.send_json({
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                # Manual mode: audio is transcribed, but no assistant response is
                # created unless a response.create event is explicitly sent.
                "turn_detection": None,
                "audio": {
                    "input": {
                        "format": {
                            "type": "pcm",
                            "sample_rate": SAMPLE_RATE,
                            "sample_format": "s16le",
                            "channels": 1,
                            "packing": "interleaved",
                            "channel_layout": "mono",
                        },
                    },
                },
                "input_audio_transcription": {"model": self.config.transcription_model},
            },
        })

    async def send_audio(self, pcm16: bytes) -> None:
        if pcm16:
            await self.send_json({
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(pcm16).decode("ascii"),
            })

    async def commit(self) -> None:
        await self.send_json({"type": "input_audio_buffer.commit"})

    async def clear(self) -> None:
        await self.send_json({"type": "input_audio_buffer.clear"})

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
            raise BailianVoiceInputError("向百炼发送音频失败，请检查网络后重试。") from exc

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        websocket, self._websocket = self._websocket, None
        if websocket is not None:
            with suppress(Exception):
                await websocket.close()


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
        deadline = asyncio.get_running_loop().time() + UPSTREAM_READY_TIMEOUT_SECONDS
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise BailianVoiceInputError("等待百炼语音识别会话就绪超时")
            event = await asyncio.wait_for(session.receive_event(), timeout=remaining)
            event_type = str(event.get("type") or "")
            if event_type == "error":
                raise BailianVoiceInputError(provider_error_message(event))
            if event_type == "session.updated":
                break
        await websocket.send_json({"type": "voice.transcription.ready"})

        audio_bytes_received = 0
        committed = False
        partial_text = ""
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
                event_type = str(event.get("type") or "")
                if event_type == "error" or event_type == "conversation.item.input_audio_transcription.failed":
                    await websocket.send_json({
                        "type": "voice.transcription.error",
                        "message": provider_error_message(event),
                    })
                    return
                if event_type == "conversation.item.input_audio_transcription.delta":
                    if "delta" in event:
                        partial_text += str(event.get("delta") or "")
                    else:
                        partial_text = str(event.get("text") or "") + str(event.get("stash") or "")
                    await websocket.send_json({
                        "type": "voice.transcription.partial",
                        "text": partial_text,
                    })
                elif event_type == "conversation.item.input_audio_transcription.completed":
                    transcript = str(event.get("transcript") or "").strip()
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
                            await session.clear()
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
