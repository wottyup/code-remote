from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import codex_remote.bailian_voice_input as voice_input


def provider_event(event: str, **values) -> str:
    return json.dumps({"header": {"event": event}, **values}, ensure_ascii=False)


class FakeProviderSocket:
    def __init__(self, *, fail_on_run: bool = False) -> None:
        self.events: asyncio.Queue[str] = asyncio.Queue()
        self.sent: list[str | bytes] = []
        self.closed = False
        self.fail_on_run = fail_on_run

    @property
    def sent_events(self) -> list[dict]:
        return [json.loads(item) for item in self.sent if isinstance(item, str)]

    async def send(self, raw: str | bytes) -> None:
        self.sent.append(raw)
        if isinstance(raw, bytes):
            await self.events.put(provider_event(
                "result-generated",
                payload={"output": {"sentence": {
                    "sentence_id": 1, "text": "你好", "sentence_end": False,
                }}},
            ))
            await self.events.put(provider_event(
                "result-generated",
                payload={"output": {"sentence": {
                    "sentence_id": 1, "text": "你好，", "sentence_end": True,
                }}},
            ))
            await self.events.put(provider_event(
                "result-generated",
                payload={"output": {"sentence": {
                    "sentence_id": 2, "text": "百炼。", "sentence_end": True,
                }}},
            ))
            return

        request = json.loads(raw)
        action = request.get("header", {}).get("action")
        if action == "run-task":
            if self.fail_on_run:
                await self.events.put(provider_event(
                    "task-failed",
                    error_code="MODEL_NOT_FOUND",
                    error_message="private provider detail",
                ))
            else:
                await self.events.put(provider_event("task-started", payload={}))
        elif action == "finish-task":
            await self.events.put(provider_event("task-finished", payload={}))

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
    def test_realtime_url_uses_workspace_region_and_fun_asr_endpoint(self) -> None:
        self.assertEqual(
            "wss://workspace_01.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference",
            voice_input.build_realtime_url("workspace_01", "cn-beijing", voice_input.DEFAULT_REALTIME_MODEL),
        )
        self.assertIn(
            "ap-southeast-1.maas.aliyuncs.com",
            voice_input.build_realtime_url("workspace", "ap-southeast-1", "fun-asr-realtime"),
        )
        with self.assertRaises(voice_input.BailianVoiceInputError):
            voice_input.build_realtime_url("workspace", "us-west-1", "fun-asr-realtime")

    def test_missing_credentials_return_a_setup_hint(self) -> None:
        config = voice_input.BailianVoiceInputConfig("", "", "cn-beijing", "model")
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
                "transcription_model": "ignored-legacy-field",
            })

            self.assertTrue(settings["configured"])
            self.assertEqual("project", settings["api_key_source"])
            self.assertEqual(voice_input.DEFAULT_REALTIME_MODEL, settings["realtime_model"])
            self.assertNotIn("transcription_model", settings)
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
            })
            self.assertTrue(settings["configured"])
            self.assertEqual("project-secret", store.get_config().api_key)

    def test_old_qwen_settings_and_environment_defaults_migrate_to_fun_asr(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            path.write_text(json.dumps({
                "api_key": "saved-key",
                "workspace_id": "saved-workspace",
                "realtime_model": "qwen3.8-omni-flash-realtime",
                "transcription_model": "qwen3-asr-flash-realtime",
            }), encoding="utf-8")
            store = voice_input.BailianVoiceInputSettingsStore(path, environ={
                "BAILIAN_REALTIME_MODEL": "qwen3.8-omni-flash-realtime",
                "BAILIAN_TRANSCRIPTION_MODEL": "qwen3-asr-flash-realtime",
            })

            self.assertEqual(voice_input.DEFAULT_REALTIME_MODEL, store.public_view()["realtime_model"])
            self.assertEqual(voice_input.DEFAULT_REALTIME_MODEL, store.get_config().model)
            self.assertNotIn("transcription_model", store.public_view())

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

    def test_connection_test_config_uses_draft_key_and_migrates_old_model(self) -> None:
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
            self.assertEqual(voice_input.DEFAULT_REALTIME_MODEL, config.model)
            self.assertFalse(path.exists())

            config = store.config_for_test({
                "api_key": "",
                "workspace_id": "draft-workspace",
                "region": "cn-beijing",
                "realtime_model": voice_input.DEFAULT_REALTIME_MODEL,
                "transcription_model": "legacy-field-is-ignored",
            })
            self.assertEqual("saved-environment-key", config.api_key)

    def test_connection_failure_messages_identify_common_statuses_without_response_details(self) -> None:
        unauthorized = SimpleNamespace(response=SimpleNamespace(status_code=401))
        forbidden = SimpleNamespace(response=SimpleNamespace(status_code=403))
        not_found = SimpleNamespace(response=SimpleNamespace(status_code=404))

        self.assertIn("API Key", voice_input.connection_error_message(unauthorized))
        self.assertIn("权限", voice_input.connection_error_message(forbidden))
        self.assertIn("Workspace", voice_input.connection_error_message(not_found))

    def test_connection_test_runs_and_finishes_task_without_audio(self) -> None:
        provider = FakeProviderSocket()
        connection: dict = {}

        async def connect(url: str, additional_headers=None, **kwargs):
            connection.update(url=url, additional_headers=additional_headers, kwargs=kwargs)
            return provider

        config = voice_input.BailianVoiceInputConfig("server-secret", "workspace", "cn-beijing", voice_input.DEFAULT_REALTIME_MODEL)
        asyncio.run(voice_input.test_bailian_voice_connection(config, websocket_connect=connect))

        self.assertEqual("Bearer server-secret", connection["additional_headers"]["Authorization"])
        self.assertEqual("workspace", connection["additional_headers"]["X-DashScope-WorkSpace"])
        self.assertEqual("codex-remote", connection["kwargs"]["user_agent_header"])
        self.assertEqual(
            ["run-task", "finish-task"],
            [event["header"]["action"] for event in provider.sent_events],
        )
        self.assertEqual(voice_input.DEFAULT_REALTIME_MODEL, provider.sent_events[0]["payload"]["model"])
        self.assertEqual(16_000, provider.sent_events[0]["payload"]["parameters"]["sample_rate"])
        self.assertFalse(any(isinstance(message, bytes) for message in provider.sent))
        self.assertTrue(provider.closed)

    def test_connection_test_maps_fun_asr_task_failure_and_closes(self) -> None:
        provider = FakeProviderSocket(fail_on_run=True)

        async def connect(_url: str, **_kwargs):
            return provider

        config = voice_input.BailianVoiceInputConfig("server-secret", "workspace", "cn-beijing", "fun-asr-realtime")
        with self.assertRaisesRegex(voice_input.BailianVoiceInputError, "对应资源") as error:
            asyncio.run(voice_input.test_bailian_voice_connection(config, websocket_connect=connect))

        self.assertNotIn("private provider detail", str(error.exception))
        self.assertTrue(provider.closed)

    def test_session_sends_binary_pcm_and_fun_asr_task_events(self) -> None:
        provider = FakeProviderSocket()
        connection: dict = {}

        async def connect(url: str, additional_headers=None, **kwargs):
            connection.update(url=url, additional_headers=additional_headers, kwargs=kwargs)
            return provider

        config = voice_input.BailianVoiceInputConfig("server-secret", "workspace", "cn-beijing", voice_input.DEFAULT_REALTIME_MODEL)

        async def exercise() -> None:
            session = voice_input.BailianVoiceInputSession(config, websocket_connect=connect)
            await session.connect()
            await session.configure()
            await session.send_audio(b"pcm16")
            await session.commit()
            await session.close()

        asyncio.run(exercise())

        self.assertEqual("Bearer server-secret", connection["additional_headers"]["Authorization"])
        self.assertEqual("/api-ws/v1/inference", connection["url"].split(".com", maxsplit=1)[1])
        self.assertEqual(["run-task", "finish-task"], [event["header"]["action"] for event in provider.sent_events])
        self.assertEqual(b"pcm16", next(message for message in provider.sent if isinstance(message, bytes)))
        self.assertEqual(
            provider.sent_events[0]["header"]["task_id"],
            provider.sent_events[1]["header"]["task_id"],
        )
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

    def test_proxy_relays_fun_asr_partial_and_completed_text_after_finish(self) -> None:
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
        partials = [event["text"] for event in browser.sent if event["type"] == "voice.transcription.partial"]
        self.assertEqual(["你好", "你好，", "你好，百炼。"], partials)
        self.assertIn({"type": "voice.transcription.completed", "text": "你好，百炼。"}, browser.sent)
        self.assertNotIn("server-secret", json.dumps(browser.sent, ensure_ascii=False))
        self.assertEqual(["run-task", "finish-task"], [event["header"]["action"] for event in provider.sent_events])
        self.assertIn(b"\x00\x01", provider.sent)
        self.assertTrue(provider.closed)


if __name__ == "__main__":
    unittest.main()
