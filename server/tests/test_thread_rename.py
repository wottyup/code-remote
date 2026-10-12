from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from codex_remote.app import ThreadNameRequest, create_app
from codex_remote.codex_app_server import CodexRuntimeError


class ThreadRenameApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        workspace = Path(self.directory.name)
        images = workspace / "images"
        images.mkdir()
        with (
            patch.dict(os.environ, {"CODEX_REMOTE_AUTH_FILE": str(workspace / "auth.json")}),
            patch("codex_remote.app.tempfile.mkdtemp", return_value=str(images)),
        ):
            self.app = create_app(workspace)
        self.server = self.app.state.codex
        self.rename = next(
            route.endpoint
            for route in self.app.routes
            if getattr(route, "path", None) == "/api/v1/codex/threads/{thread_id}/name"
        )

    async def test_renames_a_thread_after_normalizing_whitespace(self) -> None:
        self.server.set_thread_name = AsyncMock()

        result = await self.rename("thread-one", ThreadNameRequest(name="  项目   讨论  "))

        self.assertEqual(result, {"thread_id": "thread-one", "name": "项目 讨论"})
        self.server.set_thread_name.assert_awaited_once_with("thread-one", "项目 讨论")

    async def test_rejects_empty_and_overlong_names_without_calling_codex(self) -> None:
        self.server.set_thread_name = AsyncMock()

        for value in (" \n ", "x" * 73, "bad\x00name"):
            with self.subTest(name=value[:8]), self.assertRaises(HTTPException) as rejected:
                await self.rename("thread-one", ThreadNameRequest(name=value))
            self.assertEqual(rejected.exception.status_code, 422)

        self.server.set_thread_name.assert_not_awaited()

    async def test_reports_codex_server_errors_without_claiming_success(self) -> None:
        self.server.set_thread_name = AsyncMock(side_effect=CodexRuntimeError("Codex rejected the name"))

        with self.assertRaises(HTTPException) as rejected:
            await self.rename("thread-one", ThreadNameRequest(name="New title"))

        self.assertEqual(rejected.exception.status_code, 503)
        self.assertEqual(rejected.exception.detail, "Codex rejected the name")


if __name__ == "__main__":
    unittest.main()
