from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock

from watchfiles import Change

from codex_remote.codex_app_server import (
    CodexAppServer,
    CodexHandoffBusyError,
    CodexNoActiveTurnError,
    CodexRuntimeError,
    merge_workspace_change,
    snapshot_workspace,
    workspace_change_entries,
)


class CodexAppServerSandboxPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_default_app_server_uses_main_codex_home_without_reseeding_its_database(self) -> None:
        with tempfile.TemporaryDirectory() as history_directory:
            history_home = Path(history_directory)
            database = history_home / "thread_history_1.sqlite"
            connection = sqlite3.connect(database)
            try:
                connection.execute("create table marker (value text not null)")
                connection.execute("insert into marker values ('preserve')")
                connection.commit()
            finally:
                connection.close()

            old_home = os.environ.get("CODEX_HOME")
            old_runtime_home = os.environ.pop("CODEX_REMOTE_APP_SERVER_HOME", None)
            try:
                os.environ["CODEX_HOME"] = str(history_home)
                app_server = CodexAppServer("codex", Path.cwd())
                child_environment = app_server._app_server_environment()

                self.assertEqual(history_home.resolve(), app_server._runtime_home)
                self.assertEqual(str(history_home.resolve()), child_environment["CODEX_HOME"])
                await app_server._prepare_runtime_thread("not-in-history")

                connection = sqlite3.connect(database)
                try:
                    self.assertEqual(("preserve",), connection.execute("select value from marker").fetchone())
                finally:
                    connection.close()
            finally:
                if old_home is None:
                    os.environ.pop("CODEX_HOME", None)
                else:
                    os.environ["CODEX_HOME"] = old_home
                if old_runtime_home is not None:
                    os.environ["CODEX_REMOTE_APP_SERVER_HOME"] = old_runtime_home

    async def test_runtime_history_is_seeded_from_original_database_and_rollout(self) -> None:
        with tempfile.TemporaryDirectory() as history_directory, tempfile.TemporaryDirectory() as runtime_directory:
            history_home = Path(history_directory)
            runtime_home = Path(runtime_directory)
            source_db = history_home / "thread_history_1.sqlite"
            connection = sqlite3.connect(source_db)
            try:
                connection.execute("create table marker (value text not null)")
                connection.execute("insert into marker values (?)", ("source",))
                connection.execute("create table thread_history_projection_state (thread_id text not null)")
                connection.execute("insert into thread_history_projection_state values (?)", ("thread-id",))
                connection.commit()
            finally:
                connection.close()
            session_path = history_home / "sessions" / "2026" / "10" / "01" / "rollout-thread-id.jsonl"
            session_path.parent.mkdir(parents=True)
            session_path.write_text("session", encoding="utf-8")
            old_home = os.environ.get("CODEX_HOME")
            old_runtime_home = os.environ.get("CODEX_REMOTE_APP_SERVER_HOME")
            try:
                os.environ["CODEX_HOME"] = str(history_home)
                os.environ["CODEX_REMOTE_APP_SERVER_HOME"] = str(runtime_home)
                app_server = CodexAppServer("codex", Path.cwd())
                app_server._history._path_index = {"thread-id": session_path}
                await app_server._prepare_runtime_thread("thread-id")
            finally:
                if old_home is None:
                    os.environ.pop("CODEX_HOME", None)
                else:
                    os.environ["CODEX_HOME"] = old_home
                if old_runtime_home is None:
                    os.environ.pop("CODEX_REMOTE_APP_SERVER_HOME", None)
                else:
                    os.environ["CODEX_REMOTE_APP_SERVER_HOME"] = old_runtime_home

            connection = sqlite3.connect(runtime_home / "thread_history_1.sqlite")
            try:
                self.assertEqual(("source",), connection.execute("select value from marker").fetchone())
            finally:
                connection.close()
            staged_path = runtime_home / "sessions" / "2026" / "10" / "01" / session_path.name
            self.assertEqual("session", staged_path.read_text(encoding="utf-8"))

    async def test_app_server_uses_isolated_runtime_home_and_original_history_home(self) -> None:
        with tempfile.TemporaryDirectory() as history_directory, tempfile.TemporaryDirectory() as runtime_directory:
            history_home = Path(history_directory)
            (history_home / "config.toml").write_text('model = "gpt-test"\n', encoding="utf-8")
            old_home = os.environ.get("CODEX_HOME")
            old_runtime_home = os.environ.get("CODEX_REMOTE_APP_SERVER_HOME")
            try:
                os.environ["CODEX_HOME"] = str(history_home)
                os.environ["CODEX_REMOTE_APP_SERVER_HOME"] = runtime_directory
                app_server = CodexAppServer("codex", Path.cwd())
                child_environment = app_server._app_server_environment()
            finally:
                if old_home is None:
                    os.environ.pop("CODEX_HOME", None)
                else:
                    os.environ["CODEX_HOME"] = old_home
                if old_runtime_home is None:
                    os.environ.pop("CODEX_REMOTE_APP_SERVER_HOME", None)
                else:
                    os.environ["CODEX_REMOTE_APP_SERVER_HOME"] = old_runtime_home

            self.assertEqual(history_home.resolve(), app_server._history.codex_home)
            self.assertEqual(str(Path(runtime_directory).resolve()), child_environment["CODEX_HOME"])
            self.assertEqual('model = "gpt-test"', (Path(runtime_directory) / "config.toml").read_text(encoding="utf-8").strip())
    async def test_list_threads_reads_all_pages_and_merges_disk_history(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server.request = AsyncMock(side_effect=[
            {"data": [{"id": "server-1", "name": "server"}], "nextCursor": "cursor-1"},
            {"data": [{"id": "server-2", "name": "second"}], "nextCursor": None},
        ])
        app_server._history.list_threads = Mock(return_value=[
            {"id": "disk-1", "name": "disk"},
            {"id": "server-1", "name": "disk copy"},
        ])

        threads = await app_server.list_threads()

        self.assertEqual({"disk-1", "server-1", "server-2"}, {thread["id"] for thread in threads})
        self.assertEqual("server", next(thread["name"] for thread in threads if thread["id"] == "server-1"))
        self.assertEqual(2, app_server.request.await_count)

    async def test_list_threads_falls_back_to_disk_when_app_server_is_unavailable(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._history.list_threads = Mock(return_value=[{"id": "disk-1", "name": "disk"}])
        app_server.request = AsyncMock(side_effect=CodexRuntimeError("offline"))
        threads = await app_server.list_threads()

        self.assertEqual([{"id": "disk-1", "name": "disk"}], threads)

    def test_configured_models_follow_codex_catalog_and_default(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            codex_home = Path(directory)
            catalog_path = codex_home / "models-custom.json"
            catalog_path.write_text(json.dumps({
                "models": [
                    {
                        "slug": "gpt-new",
                        "display_name": "GPT New",
                        "visibility": "list",
                        "input_modalities": ["text", "image"],
                        "default_reasoning_level": "high",
                        "supported_reasoning_levels": [{"effort": "high", "description": "deep"}],
                    },
                    {"slug": "hidden", "visibility": "hide"},
                ]
            }), encoding="utf-8")
            (codex_home / "config.toml").write_text(
                f'model = "gpt-new"\nmodel_catalog_json = "{catalog_path.as_posix()}"\n',
                encoding="utf-8",
            )
            old_home = __import__("os").environ.get("CODEX_HOME")
            try:
                __import__("os").environ["CODEX_HOME"] = str(codex_home)
                app_server = CodexAppServer("codex", Path.cwd())
                models = app_server._configured_models()
            finally:
                if old_home is None:
                    __import__("os").environ.pop("CODEX_HOME", None)
                else:
                    __import__("os").environ["CODEX_HOME"] = old_home

            self.assertEqual(["gpt-new"], [model["model"] for model in models])
            self.assertTrue(models[0]["isDefault"])
            self.assertEqual("high", models[0]["defaultReasoningEffort"])
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
