from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from codex_remote.app import BailianVoiceInputSettingsRequest, create_app
from codex_remote.bailian_voice_input import BailianVoiceInputError


class BailianVoiceSettingsApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        root = Path(self.temporary_directory.name).resolve()
        image_directory = root / "temporary-images"
        image_directory.mkdir()
        with (
            patch.dict(os.environ, {"CODEX_REMOTE_AUTH_FILE": str(root / "auth.json")}),
            patch("codex_remote.app.tempfile.mkdtemp", return_value=str(image_directory)),
        ):
            self.app = create_app(root)
        self.addCleanup(self.app.state.shared_state.close)
        self.addAsyncCleanup(self.app.state.claude_code.close)
        self.test_endpoint = next(
            route.endpoint
            for route in self.app.routes
            if getattr(route, "path", None) == "/api/v1/settings/bailian-voice/test"
            and "POST" in getattr(route, "methods", set())
        )

    async def test_connection_test_uses_draft_settings_and_does_not_persist_them(self) -> None:
        request = BailianVoiceInputSettingsRequest(
            api_key="temporary-key",
            workspace_id="temporary-workspace",
            region="cn-beijing",
            realtime_model="realtime-model",
            transcription_model="transcription-model",
        )

        with patch("codex_remote.app.test_bailian_voice_connection", new=AsyncMock()) as test_connection:
            result = await self.test_endpoint(request)

        self.assertTrue(result["success"])
        self.assertIn("未发送音频", result["message"])
        tested_config = test_connection.await_args.args[0]
        self.assertEqual("temporary-key", tested_config.api_key)
        self.assertFalse((self.app.state.auth.state_path.parent / "bailian-voice-settings.json").exists())

    async def test_default_model_is_fun_asr_and_old_transcription_field_is_ignored(self) -> None:
        request = BailianVoiceInputSettingsRequest(
            api_key="temporary-key",
            workspace_id="temporary-workspace",
            transcription_model="old-client-value",
        )

        with patch("codex_remote.app.test_bailian_voice_connection", new=AsyncMock()) as test_connection:
            await self.test_endpoint(request)

        tested_config = test_connection.await_args.args[0]
        self.assertEqual("fun-asr-realtime-2026-02-28", tested_config.model)

    async def test_missing_key_returns_setup_error_without_attempting_connection(self) -> None:
        request = BailianVoiceInputSettingsRequest(
            workspace_id="temporary-workspace",
            region="cn-beijing",
            realtime_model="realtime-model",
            transcription_model="transcription-model",
        )

        with patch("codex_remote.app.test_bailian_voice_connection", new=AsyncMock()) as test_connection:
            with self.assertRaises(HTTPException) as raised:
                await self.test_endpoint(request)

        self.assertEqual(422, raised.exception.status_code)
        test_connection.assert_not_awaited()

    async def test_upstream_failure_returns_safe_bad_gateway_detail(self) -> None:
        request = BailianVoiceInputSettingsRequest(
            api_key="temporary-key",
            workspace_id="temporary-workspace",
            region="cn-beijing",
            realtime_model="realtime-model",
            transcription_model="transcription-model",
        )

        with patch(
            "codex_remote.app.test_bailian_voice_connection",
            new=AsyncMock(side_effect=BailianVoiceInputError("百炼鉴权失败（HTTP 401）。")),
        ):
            with self.assertRaises(HTTPException) as raised:
                await self.test_endpoint(request)

        self.assertEqual(502, raised.exception.status_code)
        self.assertEqual("百炼鉴权失败（HTTP 401）。", raised.exception.detail)


if __name__ == "__main__":
    unittest.main()
