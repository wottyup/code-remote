from __future__ import annotations

import asyncio
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from watchfiles import Change

from codex_remote.codex_app_server import (
    CodexAppServer,
    CodexHandoffBusyError,
    CodexNoActiveTurnError,
    CodexRuntimeError,
    merge_workspace_change,
    workspace_change_entries,
)


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

    async def test_steer_uses_the_server_active_turn_id(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._active_turn_ids["thread-id"] = "current-turn-id"
        app_server.request = AsyncMock(return_value={"turnId": "current-turn-id"})

        result = await app_server.steer_turn("thread-id", "Focus on tests first.")

        self.assertEqual(result, {"turnId": "current-turn-id"})
        self.assertEqual(
            app_server.request.await_args.args,
            (
                "turn/steer",
                {
                    "threadId": "thread-id",
                    "input": [{"type": "text", "text": "Focus on tests first."}],
                    "expectedTurnId": "current-turn-id",
                },
            ),
        )

    async def test_steer_waits_for_a_turn_that_is_still_starting(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        pending_start = asyncio.get_running_loop().create_future()
        app_server._pending_turn_starts["thread-id"] = pending_start
        app_server.request = AsyncMock(return_value={"turnId": "turn-id"})

        steer = asyncio.create_task(app_server.steer_turn("thread-id", "Please include the results."))
        await asyncio.sleep(0)
        pending_start.set_result("turn-id")
        await steer

        self.assertEqual(
            app_server.request.await_args.args,
            (
                "turn/steer",
                {
                    "threadId": "thread-id",
                    "input": [{"type": "text", "text": "Please include the results."}],
                    "expectedTurnId": "turn-id",
                },
            ),
        )

    async def test_steer_requires_a_server_active_turn(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())

        with self.assertRaises(CodexNoActiveTurnError):
            await app_server.steer_turn("thread-id", "hello")

    async def test_completion_finishes_workspace_watch_before_notifying_clients(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._active_turn_ids["thread-id"] = "turn-id"
        order: list[str] = []

        async def complete_watch(thread_id: str, turn_id: str | None) -> None:
            self.assertEqual((thread_id, turn_id), ("thread-id", "turn-id"))
            order.append("watch")

        async def emit(event: dict[str, object]) -> None:
            order.append(str(event.get("method")))

        app_server._complete_workspace_change_watch = complete_watch  # type: ignore[method-assign]
        app_server._emit = emit  # type: ignore[method-assign]

        await app_server._handle_message({
            "method": "turn/completed",
            "params": {"threadId": "thread-id", "turnId": "turn-id"},
        })

        self.assertEqual(order, ["watch", "turn/completed"])

    async def test_handoff_closes_an_idle_remote_runtime_and_blocks_background_requests(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server.close = AsyncMock()

        await app_server.handoff_to_local_codex()

        self.assertTrue(app_server.handed_off)
        self.assertTrue(app_server.status()["handedOff"])
        app_server.close.assert_awaited_once()
        with self.assertRaises(CodexRuntimeError):
            await app_server.request("thread/list", {"limit": 100})

    async def test_handoff_refuses_to_interrupt_an_active_or_starting_turn(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server.close = AsyncMock()
        app_server._active_turn_ids["thread-id"] = "turn-id"

        with self.assertRaises(CodexHandoffBusyError):
            await app_server.handoff_to_local_codex()

        self.assertFalse(app_server.handed_off)
        app_server.close.assert_not_awaited()

        app_server._active_turn_ids.clear()
        app_server._pending_turn_starts["thread-id"] = asyncio.get_running_loop().create_future()
        with self.assertRaises(CodexHandoffBusyError):
            await app_server.handoff_to_local_codex()

        self.assertFalse(app_server.handed_off)
        app_server.close.assert_not_awaited()

    async def test_reclaim_allows_remote_requests_again(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server.close = AsyncMock()
        await app_server.handoff_to_local_codex()

        runtime = await app_server.reclaim_for_remote()

        self.assertFalse(app_server.handed_off)
        self.assertFalse(runtime["handedOff"])

    async def test_read_thread_keeps_workspace_changes_for_each_completed_turn(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server.request = AsyncMock(return_value={"thread": {
            "id": "thread-id",
            "turns": [{"id": "turn-one"}, {"id": "turn-two"}],
        }})
        app_server._workspace_change_results["thread-id"] = {
            "turn-one": [{"path": "src/one.ts", "kind": "update"}],
            "turn-two": [{"path": "src/two.ts", "kind": "add"}],
            "stale-turn": [{"path": "src/old.ts", "kind": "delete"}],
        }

        thread = await app_server.read_thread("thread-id")

        self.assertEqual(thread["codexRemoteWorkspaceChanges"], {
            "turn-one": [{"path": "src/one.ts", "kind": "update"}],
            "turn-two": [{"path": "src/two.ts", "kind": "add"}],
        })


class WorkspaceChangeMergeTests(unittest.TestCase):
    def test_workspace_change_merge_keeps_only_the_final_file_operation(self) -> None:
        changes: dict[str, str] = {}

        merge_workspace_change(changes, "src/new.ts", Change.added)
        merge_workspace_change(changes, "src/new.ts", Change.modified)
        merge_workspace_change(changes, "src/new.ts", Change.deleted)
        merge_workspace_change(changes, "src/existing.ts", Change.deleted)
        merge_workspace_change(changes, "src/existing.ts", Change.added)

        self.assertEqual(workspace_change_entries(changes), [
            {"path": "src/existing.ts", "kind": "update"},
        ])


if __name__ == "__main__":
    unittest.main()
