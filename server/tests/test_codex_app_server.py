from __future__ import annotations

import asyncio
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from codex_remote.codex_app_server import CodexAppServer


class CodexAppServerSandboxPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_thread_and_turn_use_their_respective_sandbox_enum_formats(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server.request = AsyncMock(side_effect=[
            {"thread": {"id": "thread-id"}},
            {"turn": {"id": "turn-id"}},
        ])

        await app_server.start_thread(approval_policy="never")
        await app_server.start_turn("thread-id", "hello", approval_policy="never")

        self.assertEqual(
            app_server.request.await_args_list[0].args,
            (
                "thread/start",
                {
                    "cwd": str(Path.cwd()),
                    "serviceName": "codex_remote_web",
                    "approvalPolicy": "never",
                    "sandbox": "danger-full-access",
                },
            ),
        )
        self.assertEqual(
            app_server.request.await_args_list[1].args,
            (
                "turn/start",
                {
                    "threadId": "thread-id",
                    "input": [{"type": "text", "text": "hello"}],
                    "approvalPolicy": "never",
                    "sandboxPolicy": {"type": "dangerFullAccess"},
                },
            ),
        )

    async def test_interrupt_prefers_the_server_active_turn_over_a_stale_client_turn(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._active_turn_ids["thread-id"] = "current-turn-id"
        app_server.request = AsyncMock(return_value={"interrupted": True})

        await app_server.interrupt("thread-id", "stale-turn-id")

        self.assertEqual(
            app_server.request.await_args.args,
            (
                "turn/interrupt",
                {"threadId": "thread-id", "turnId": "current-turn-id"},
            ),
        )

    async def test_interrupt_waits_for_a_turn_that_is_still_starting(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        pending_start = asyncio.get_running_loop().create_future()
        app_server._pending_turn_starts["thread-id"] = pending_start
        app_server.request = AsyncMock(return_value={"interrupted": True})

        interrupt = asyncio.create_task(app_server.interrupt("thread-id"))
        await asyncio.sleep(0)
        pending_start.set_result("turn-id")
        await interrupt

        self.assertEqual(
            app_server.request.await_args.args,
            (
                "turn/interrupt",
                {"threadId": "thread-id", "turnId": "turn-id"},
            ),
        )


if __name__ == "__main__":
    unittest.main()
