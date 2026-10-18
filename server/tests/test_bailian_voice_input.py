from __future__ import annotations

import asyncio
import base64
import json
import os
import tempfile
from types import SimpleNamespace
import unittest
from pathlib import Path
from unittest.mock import patch

import codex_remote.bailian_voice_input as voice_input


class FakeProviderSocket:
    def __init__(self) -> None:
        self.events: asyncio.Queue[str] = asyncio.Queue()
        self.sent: list[dict] = []
        self.closed = False

    async def send(self, raw: str) -> None:
        event = json.loads(raw)
        self.sent.append(event)
        if event.get("type") == "session.update":
            await self.events.put(json.dumps({"type": "session.updated"}))
        elif event.get("type") == "input_audio_buffer.commit":
            await self.events.put(json.dumps({
                "type": "conversation.item.input_audio_transcription.delta",
                "delta": "你好",
            }))
            await self.events.put(json.dumps({
                "type": "conversation.item.input_audio_transcription.completed",
                "transcript": "你好，百炼。",
            }))

    async def recv(self) -> str:
        return await self.events.get()

    async def close(self) -> None:
        self.closed = True


class FakeBrowserSocket:
    def __init__(self, incoming: list[dict], hello: dict | None = None) -> None:
        self.incoming: asyncio.Queue[dict] = asyncio.Queue()
        for message in incoming:
            self.incoming.put_nowait(message)
        self.hello = hello or {
            "type": "voice.transcription.hello",
            "protocol_version": 1,
            "token": "paired-token",
        }
        self.sent: list[dict] = []
        self.accepted = False
        self.close_args: dict = {}

    async def accept(self) -> None:
        self.accepted = True

    async def receive_json(self) -> dict:
        return self.hello

    async def receive(self) -> dict:
        return await self.incoming.get()

    async def send_json(self, event: dict) -> None:
        self.sent.append(event)

    async def close(self, **kwargs) -> None:
        self.close_args = kwargs


class FakeAuth:
    def __init__(self, accepted: bool = True) -> None:
        self.accepted = accepted

    def accepts(self, token: str | None) -> bool:
        return self.accepted and token == "paired-token"


class BailianVoiceInputTests(unittest.TestCase):
    def test_realtime_url_uses_workspace_region_and_escaped_model(self) -> None:
        self.assertEqual(
            "wss://workspace_01.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime",
            voice_input.build_realtime_url("workspace_01", "cn-beijing", "qwen3.8-omni-flash-realtime"),
        )
        self.assertIn(
            "ap-southeast-1.maas.aliyuncs.com",
            voice_input.build_realtime_url("workspace", "ap-southeast-1", "model"),
        )
        with self.assertRaises(voice_input.BailianVoiceInputError):
            voice_input.build_realtime_url("workspace", "us-west-1", "model")

    def test_missing_credentials_return_a_setup_hint(self) -> None:
        config = voice_input.BailianVoiceInputConfig("", "", "cn-beijing", "model", "qwen3-asr-flash-realtime")
        with self.assertRaisesRegex(voice_input.BailianVoiceInputError, "项目设置"):
            config.validate()

    def test_settings_store_persists_secret_privately_and_keeps_it_out_of_public_view(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bailian-voice-settings.json"
            store = voice_input.BailianVoiceInputSettingsStore(path, environ={})
            settings = store.update({
                "api_key": "project-secret",
                "workspace_id": "project-workspace",
                "region": "cn-beijing",
                "realtime_model": voice_input.DEFAULT_REALTIME_MODEL,
                "transcription_model": voice_input.DEFAULT_TRANSCRIPTION_MODEL,
            })

            self.assertTrue(settings["configured"])
            self.assertEqual("project", settings["api_key_source"])
            self.assertNotIn("api_key", settings)
            self.assertNotIn("project-secret", json.dumps(settings))
            self.assertEqual("project-secret", voice_input.BailianVoiceInputSettingsStore(path, environ={}).get_config().api_key)
            if os.name != "nt":
                self.assertEqual(0o600, path.stat().st_mode & 0o777)

            settings = store.update({
                "api_key": "",
                "workspace_id": "project-workspace",
                "region": "cn-beijing",
                "realtime_model": voice_input.DEFAULT_REALTIME_MODEL,
                "transcription_model": voice_input.DEFAULT_TRANSCRIPTION_MODEL,
            })
            self.assertTrue(settings["configured"])
            self.assertEqual("project-secret", store.get_config().api_key)

    def test_settings_store_falls_back_to_environment_and_reset_restores_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = voice_input.BailianVoiceInputSettingsStore(Path(directory) / "settings.json", environ={
                "DASHSCOPE_API_KEY": "environment-secret",
                "BAILIAN_WORKSPACE_ID": "environment-workspace",
            })
            settings = store.public_view()
            self.assertTrue(settings["configured"])
            self.assertEqual("environment", settings["api_key_source"])
            self.assertNotIn("environment-secret", json.dumps(settings))
            self.assertTrue(store.reset()["configured"])
            self.assertEqual("environment-secret", store.get_config().api_key)

    def test_connection_test_config_uses_draft_key_without_persisting_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bailian-voice-settings.json"
            store = voice_input.BailianVoiceInputSettingsStore(path, environ={
                "DASHSCOPE_API_KEY": "saved-environment-key",
            })

            config = store.config_for_test({
                "api_key": "draft-key",
                "workspace_id": "draft-workspace",
                "region": "cn-beijing",
                "realtime_model": "qwen3.8-omni-flash-realtime",
                "transcription_model": "qwen3-asr-flash-realtime",
            })

            self.assertEqual("draft-key", config.api_key)
            self.assertEqual("draft-workspace", config.workspace_id)
            self.assertFalse(path.exists())

            config = store.config_for_test({
                "api_key": "",
                "workspace_id": "draft-workspace",
                "region": "cn-beijing",
                "realtime_model": "qwen3.8-omni-flash-realtime",
                "transcription_model": "qwen3-asr-flash-realtime",
            })
            self.assertEqual("saved-environment-key", config.api_key)

    def test_connection_failure_messages_identify_common_statuses_without_response_details(self) -> None:
        unauthorized = SimpleNamespace(response=SimpleNamespace(status_code=401))
        forbidden = SimpleNamespace(response=SimpleNamespace(status_code=403))
        not_found = SimpleNamespace(response=SimpleNamespace(status_code=404))

        self.assertIn("API Key", voice_input.connection_error_message(unauthorized))
        self.assertIn("权限", voice_input.connection_error_message(forbidden))
        self.assertIn("Workspace", voice_input.connection_error_message(not_found))

    def test_connection_test_opens_configured_session_without_audio_and_closes(self) -> None:
        provider = FakeProviderSocket()
        connection: dict = {}

        async def connect(url: str, additional_headers=None, **kwargs):
            connection.update(url=url, additional_headers=additional_headers)
            return provider

        config = voice_input.BailianVoiceInputConfig(
            "server-secret", "workspace", "cn-beijing", "realtime-model", "transcription-model",
        )
        asyncio.run(voice_input.test_bailian_voice_connection(config, websocket_connect=connect))

        self.assertEqual("Bearer server-secret", connection["additional_headers"]["Authorization"])
        self.assertEqual(["session.update"], [event["type"] for event in provider.sent])
        self.assertTrue(provider.closed)

    def test_connection_test_maps_provider_setup_errors_and_closes(self) -> None:
        provider = FakeProviderSocket()

        async def send_error(raw: str) -> None:
            event = json.loads(raw)
            provider.sent.append(event)
            if event.get("type") == "session.update":
                await provider.events.put(json.dumps({
                    "type": "error",
                    "error": {"code": "workspace_not_found", "message": "private provider detail"},
                }))

        provider.send = send_error

        async def connect(_url: str, **_kwargs):
            return provider

        config = voice_input.BailianVoiceInputConfig(
            "server-secret", "workspace", "cn-beijing", "realtime-model", "transcription-model",
        )
        with self.assertRaisesRegex(voice_input.BailianVoiceInputError, "Workspace ID") as error:
            asyncio.run(voice_input.test_bailian_voice_connection(config, websocket_connect=connect))

        self.assertNotIn("private provider detail", str(error.exception))
        self.assertTrue(provider.closed)

    def test_manual_session_only_configures_transcription_and_commits_audio(self) -> None:
        provider = FakeProviderSocket()
        connection: dict = {}

        async def connect(url: str, additional_headers=None, **kwargs):
            connection.update(url=url, additional_headers=additional_headers, kwargs=kwargs)
            return provider

        config = voice_input.BailianVoiceInputConfig(
            "server-secret", "workspace", "cn-beijing", "qwen3.8-omni-flash-realtime", "qwen3-asr-flash-realtime",
        )

        async def exercise() -> None:
            session = voice_input.BailianVoiceInputSession(config, websocket_connect=connect)
            await session.connect()
            await session.configure()
            await session.send_audio(b"pcm16")
            await session.commit()
            await session.close()

        asyncio.run(exercise())

        self.assertEqual("Bearer server-secret", connection["additional_headers"]["Authorization"])
        self.assertEqual(voice_input.SAMPLE_RATE, provider.sent[0]["session"]["audio"]["input"]["format"]["sample_rate"])
        self.assertIsNone(provider.sent[0]["session"]["turn_detection"])
        self.assertEqual("qwen3-asr-flash-realtime", provider.sent[0]["session"]["input_audio_transcription"]["model"])
        self.assertEqual(base64.b64encode(b"pcm16").decode("ascii"), provider.sent[1]["audio"])
        self.assertEqual("input_audio_buffer.commit", provider.sent[2]["type"])
        self.assertNotIn("response.create", [event["type"] for event in provider.sent])
        self.assertTrue(provider.closed)

    def test_unpaired_browser_is_rejected_before_opening_bailian(self) -> None:
        browser = FakeBrowserSocket([], hello={
            "type": "voice.transcription.hello",
            "protocol_version": 1,
            "token": "wrong-token",
        })

        asyncio.run(voice_input.run_voice_input_websocket(browser, FakeAuth()))

        self.assertTrue(browser.accepted)
        self.assertEqual(1008, browser.close_args["code"])

    def test_proxy_relays_transcription_but_never_requests_a_response(self) -> None:
        browser = FakeBrowserSocket([
            {"type": "websocket.receive", "bytes": b"\x00\x01"},
            {"type": "websocket.receive", "text": json.dumps({"type": "voice.transcription.commit"})},
        ])
        provider = FakeProviderSocket()
        real_session_type = voice_input.BailianVoiceInputSession

        def make_session(config):
            async def connect(_url: str, **_kwargs):
                return provider

            return real_session_type(config, websocket_connect=connect)

        with (
            patch.dict(os.environ, {
                "DASHSCOPE_API_KEY": "server-secret",
                "BAILIAN_WORKSPACE_ID": "workspace",
                "BAILIAN_REGION": "cn-beijing",
            }, clear=False),
            patch.object(voice_input, "BailianVoiceInputSession", side_effect=make_session),
        ):
            asyncio.run(voice_input.run_voice_input_websocket(browser, FakeAuth()))

        self.assertIn({"type": "voice.transcription.ready"}, browser.sent)
        self.assertIn({"type": "voice.transcription.partial", "text": "你好"}, browser.sent)
        self.assertIn({"type": "voice.transcription.completed", "text": "你好，百炼。"}, browser.sent)
        self.assertNotIn("server-secret", json.dumps(browser.sent, ensure_ascii=False))
        provider_types = [event["type"] for event in provider.sent]
        self.assertIn("input_audio_buffer.append", provider_types)
        self.assertIn("input_audio_buffer.commit", provider_types)
        self.assertNotIn("response.create", provider_types)
        self.assertTrue(provider.closed)


if __name__ == "__main__":
    unittest.main()
