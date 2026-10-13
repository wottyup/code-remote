from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from watchfiles import Change

from codex_remote.codex_app_server import (
    CodexAppServer,
    CodexHandoffBusyError,
    CodexNoActiveTurnError,
    CodexRuntimeError,
    WorkspaceChangeCapture,
    WorkspaceChangeWatch,
    WorkspaceSnapshot,
    merge_workspace_change,
    snapshot_workspace,
    workspace_change_entries,
)


class CodexAppServerSandboxPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_set_thread_name_uses_the_codex_app_server_method(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server.request = AsyncMock(return_value={})

        await app_server.set_thread_name("thread-id", "Project notes")

        app_server.request.assert_awaited_once_with(
            "thread/name/set",
            {"threadId": "thread-id", "name": "Project notes"},
        )

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

    async def test_slow_review_does_not_block_completion_or_following_rpc(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._active_turn_ids["thread-id"] = "turn-id"
        changes = asyncio.create_task(asyncio.sleep(0, result={}))
        old_watch = WorkspaceChangeWatch(asyncio.Event(), changes, WorkspaceSnapshot(frozenset(), {}, True))
        app_server._workspace_change_watches["thread-id"] = old_watch
        entered = asyncio.Event()
        release = asyncio.Event()

        async def collect(watch: WorkspaceChangeWatch, *, collect: bool) -> WorkspaceChangeCapture:
            self.assertIs(watch, old_watch)
            self.assertTrue(collect)
            entered.set()
            await release.wait()
            return WorkspaceChangeCapture({}, watch.baseline)

        app_server._collect_workspace_change_watch = collect  # type: ignore[method-assign]
        events = await app_server.subscribe()
        await asyncio.wait_for(app_server._handle_message({
            "method": "turn/completed",
            "params": {"threadId": "thread-id", "turnId": "turn-id"},
        }), 1)
        await asyncio.wait_for(entered.wait(), 1)
        self.assertIsNone(await app_server._active_turn_id("thread-id"))
        self.assertEqual(events.get_nowait()["method"], "turn/completed")
        self.assertNotIn("thread-id", app_server._workspace_change_watches)

        pending = asyncio.get_running_loop().create_future()
        app_server._pending["read-next"] = pending
        await app_server._handle_message({"id": "read-next", "result": {"ok": True}})
        self.assertEqual(await asyncio.wait_for(pending, 1), {"ok": True})
        new_watch = WorkspaceChangeWatch(asyncio.Event(), changes, old_watch.baseline)
        app_server._workspace_change_watches["thread-id"] = new_watch
        release.set()
        await asyncio.gather(*app_server._workspace_completion_tasks)
        self.assertIs(app_server._workspace_change_watches["thread-id"], new_watch)
        app_server._collect_workspace_change_watch = CodexAppServer._collect_workspace_change_watch.__get__(app_server)
        await app_server._clear_workspace_change_watches()

    async def test_late_start_ack_does_not_restore_an_already_completed_turn(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._start_workspace_change_watch = AsyncMock()

        async def start_ack(*_args: object) -> dict[str, object]:
            await app_server._handle_message({"method": "turn/started", "params": {
                "threadId": "thread-id", "turn": {"id": "turn-id"},
            }})
            await app_server._handle_message({"method": "turn/completed", "params": {
                "threadId": "thread-id", "turn": {"id": "turn-id", "status": "completed"},
            }})
            return {"turn": {"id": "turn-id", "status": "inProgress"}}

        app_server.request = AsyncMock(side_effect=start_ack)
        await app_server.start_turn("thread-id", "hello")
        self.assertIsNone(await app_server._active_turn_id("thread-id"))

    async def test_waiting_for_start_does_not_return_a_turn_that_already_finished(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._pending_turn_starts["thread-id"] = asyncio.get_running_loop().create_future()
        waiting = asyncio.create_task(app_server._active_turn_id("thread-id"))
        await asyncio.sleep(0)
        await app_server._handle_message({"method": "turn/started", "params": {
            "threadId": "thread-id", "turn": {"id": "turn-id"},
        }})
        await app_server._handle_message({"method": "turn/completed", "params": {
            "threadId": "thread-id", "turn": {"id": "turn-id", "status": "completed"},
        }})
        self.assertIsNone(await waiting)

    async def test_late_completion_cannot_take_a_newer_turns_watcher(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._active_turn_ids["thread-id"] = "new-turn"
        changes = asyncio.create_task(asyncio.sleep(0, result={}))
        watch = WorkspaceChangeWatch(asyncio.Event(), changes, WorkspaceSnapshot(frozenset(), {}, True))
        app_server._workspace_change_watches["thread-id"] = watch
        await app_server._handle_message({"method": "turn/completed", "params": {
            "threadId": "thread-id", "turn": {"id": "old-turn", "status": "completed"},
        }})
        self.assertEqual(await app_server._active_turn_id("thread-id"), "new-turn")
        self.assertIs(app_server._workspace_change_watches["thread-id"], watch)
        self.assertFalse(app_server._workspace_completion_tasks)
        await app_server._clear_workspace_change_watches()

    async def test_shutdown_closes_a_detached_watch_before_cleanup_task_starts(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())

        async def wait_for_stop() -> dict[str, str]:
            await asyncio.Event().wait()
            return {}

        watch = WorkspaceChangeWatch(asyncio.Event(), asyncio.create_task(wait_for_stop()), WorkspaceSnapshot(frozenset(), {}, True))
        app_server._workspace_change_watches["thread-id"] = watch
        await app_server._handle_message({"method": "turn/completed", "params": {
            "threadId": "thread-id", "turn": {"id": "turn-id", "status": "completed"},
        }})
        await app_server._clear_workspace_change_watches()
        self.assertTrue(watch.stop_event.is_set())
        self.assertTrue(watch.task.done())
        self.assertFalse(app_server._workspace_completion_tasks)

    async def test_idle_summary_reconciles_only_the_observed_active_turn(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._active_turn_ids["thread-id"] = "stale"
        app_server.request = AsyncMock(return_value={"thread": {"status": {"type": "idle"}}})
        await app_server.read_thread("thread-id", include_turns=False)
        self.assertIsNone(await app_server._active_turn_id("thread-id"))

        app_server._active_turn_ids["thread-id"] = "stale"

        async def newer_turn(*_args: object) -> dict[str, object]:
            await app_server._handle_message({"method": "turn/started", "params": {
                "threadId": "thread-id", "turn": {"id": "new-turn"},
            }})
            return {"thread": {"status": {"type": "idle"}}}

        app_server.request.side_effect = newer_turn
        await app_server.read_thread("thread-id", include_turns=False)
        self.assertEqual(await app_server._active_turn_id("thread-id"), "new-turn")

    async def test_history_reconciles_completed_but_not_running_cached_turn(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._active_turn_ids["thread-id"] = "turn-id"
        app_server.request = AsyncMock(return_value={"thread": {"turns": [{"id": "turn-id", "status": "inProgress"}]}})
        await app_server.read_thread("thread-id")
        self.assertEqual(await app_server._active_turn_id("thread-id"), "turn-id")
        app_server.request.return_value = {"thread": {"turns": [{"id": "turn-id", "status": "completed"}]}}
        await app_server.read_thread("thread-id")
        self.assertIsNone(await app_server._active_turn_id("thread-id"))

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

        self.assertEqual(changes, {"src/existing.ts": "update"})


class WorkspaceDiffSnapshotTests(unittest.TestCase):
    def test_snapshot_diff_reports_totals_for_added_modified_and_deleted_text_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            workspace = Path(temporary_directory)
            (workspace / "src").mkdir()
            (workspace / "src/updated.ts").write_text("old\nsame\n", encoding="utf-8")
            (workspace / "src/deleted.ts").write_text("first\nsecond\n", encoding="utf-8")
            (workspace / ".git").mkdir()
            (workspace / ".git/ignored.ts").write_text("ignored\n", encoding="utf-8")
            (workspace / "node_modules").mkdir()
            (workspace / "node_modules/ignored.ts").write_text("ignored\n", encoding="utf-8")

            baseline = snapshot_workspace(workspace)
            self.assertNotIn(".git/ignored.ts", baseline.paths)
            self.assertNotIn("node_modules/ignored.ts", baseline.paths)
            (workspace / "src/updated.ts").write_text("new\nsame\nadded\n", encoding="utf-8")
            (workspace / "src/added.ts").write_text("one\ntwo\n", encoding="utf-8")
            (workspace / "src/deleted.ts").unlink()

            entries = workspace_change_entries({
                "src/updated.ts": "update",
                "src/added.ts": "add",
                "src/deleted.ts": "delete",
            }, workspace, baseline)

        changes_by_path = {entry["path"]: entry for entry in entries}
        self.assertEqual((changes_by_path["src/updated.ts"]["additions"], changes_by_path["src/updated.ts"]["deletions"]), (2, 1))
        self.assertEqual((changes_by_path["src/added.ts"]["additions"], changes_by_path["src/added.ts"]["deletions"]), (2, 0))
        self.assertEqual((changes_by_path["src/deleted.ts"]["additions"], changes_by_path["src/deleted.ts"]["deletions"]), (0, 2))
        self.assertIn("@@", changes_by_path["src/updated.ts"]["diff"])

    def test_snapshot_skips_binary_and_oversized_files_without_faking_counts(self) -> None:
        from codex_remote.codex_app_server import _WORKSPACE_DIFF_MAX_FILE_BYTES

        with tempfile.TemporaryDirectory() as temporary_directory:
            workspace = Path(temporary_directory)
            (workspace / "binary.dat").write_bytes(b"before\0binary")
            (workspace / "large.txt").write_bytes(b"x" * (_WORKSPACE_DIFF_MAX_FILE_BYTES + 1))
            baseline = snapshot_workspace(workspace)
            (workspace / "binary.dat").write_text("after\n", encoding="utf-8")
            (workspace / "large.txt").write_text("after\n", encoding="utf-8")

            entries = workspace_change_entries({"binary.dat": "update", "large.txt": "update"}, workspace, baseline)

        self.assertEqual({entry["path"] for entry in entries}, {"binary.dat", "large.txt"})
        self.assertTrue(all("diff" not in entry and "additions" not in entry for entry in entries))


if __name__ == "__main__":
    unittest.main()
