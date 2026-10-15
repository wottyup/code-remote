from __future__ import annotations

import asyncio
import json
import os
import hashlib
import shutil
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from watchfiles import Change

from codex_remote.codex_app_server import (
    CodexAppServer,
    CodexHandoffBusyError,
    CodexNoActiveTurnError,
    CodexRuntimeError,
    CodexThreadBusyError,
    WorkspaceChangeCapture,
    WorkspaceChangeWatch,
    WorkspaceSnapshot,
    merge_workspace_change,
    snapshot_workspace,
    workspace_change_entries,
    workspace_snapshot_changes,
)


class CodexAppServerSandboxPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_starting_with_shared_codex_home_does_not_delete_database_missing_projection_table(self) -> None:
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
            old_runtime_home = os.environ.get("CODEX_REMOTE_APP_SERVER_HOME")
            try:
                os.environ["CODEX_HOME"] = str(history_home)
                os.environ["CODEX_REMOTE_APP_SERVER_HOME"] = str(history_home)
                app_server = CodexAppServer("codex", Path.cwd())
                app_server._resolve_executable = Mock(return_value="codex")  # type: ignore[method-assign]
                with patch(
                    "codex_remote.codex_app_server.asyncio.create_subprocess_exec",
                    new_callable=AsyncMock,
                    side_effect=OSError("stop after database preparation"),
                ), self.assertRaises(CodexRuntimeError):
                    await app_server._ensure_started()

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
                if old_runtime_home is None:
                    os.environ.pop("CODEX_REMOTE_APP_SERVER_HOME", None)
                else:
                    os.environ["CODEX_REMOTE_APP_SERVER_HOME"] = old_runtime_home

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
                self.assertEqual(os.name == "nt", app_server._use_windows_websocket)
                self.assertEqual(
                    ["codex", "app-server", "--listen", "stdio://"],
                    app_server._app_server_arguments("codex"),
                )
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

    async def test_runtime_rollout_copy_uses_unique_temp_and_replaces_with_stopped_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as history_directory, tempfile.TemporaryDirectory() as runtime_directory:
            history_home = Path(history_directory)
            runtime_home = Path(runtime_directory)
            relative = Path("sessions") / "2026" / "10" / "01" / "rollout-thread-id.jsonl"
            source = history_home / relative
            target = runtime_home / relative
            source.parent.mkdir(parents=True)
            target.parent.mkdir(parents=True)
            source.write_text("updated", encoding="utf-8")
            target.write_text("old", encoding="utf-8")
            app_server = CodexAppServer("codex", Path.cwd())
            app_server._history_home = history_home
            app_server._runtime_home = runtime_home
            app_server._initialized = True
            app_server._process = Mock(returncode=None)
            app_server._stop_process = AsyncMock()  # type: ignore[method-assign]
            replace = os.replace
            replace_calls = 0

            def fail_once_for_open_target(source_path: Path, target_path: Path) -> None:
                nonlocal replace_calls
                replace_calls += 1
                if replace_calls == 1:
                    self.assertNotEqual(Path(f"{target}.tmp"), source_path)
                    raise PermissionError("target is open")
                replace(source_path, target_path)

            with patch("codex_remote.codex_app_server.os.replace", side_effect=fail_once_for_open_target):
                await app_server._copy_thread_rollout("thread-id")

            self.assertEqual("updated", target.read_text(encoding="utf-8"))
            app_server._stop_process.assert_awaited_once()

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
            self.assertFalse(app_server._use_windows_websocket)
            self.assertEqual(
                ["codex", "app-server", "--listen", "stdio://"],
                app_server._app_server_arguments("codex"),
            )
            self.assertEqual('model = "gpt-test"', (Path(runtime_directory) / "config.toml").read_text(encoding="utf-8").strip())

    async def test_runtime_rollout_is_copied_to_main_history_and_extended_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as history_directory, tempfile.TemporaryDirectory() as runtime_directory:
            history_home = Path(history_directory)
            runtime_home = Path(runtime_directory)
            source = runtime_home / "sessions" / "2026" / "10" / "12" / "rollout-thread-id.jsonl"
            source.parent.mkdir(parents=True)
            first_line = json.dumps({
                "type": "session_meta",
                "payload": {"id": "thread-id", "session_id": "thread-id"},
            }) + "\n"
            source.write_text(first_line, encoding="utf-8")
            old_home = os.environ.get("CODEX_HOME")
            old_runtime_home = os.environ.get("CODEX_REMOTE_APP_SERVER_HOME")
            try:
                os.environ["CODEX_HOME"] = str(history_home)
                os.environ["CODEX_REMOTE_APP_SERVER_HOME"] = str(runtime_home)
                app_server = CodexAppServer("codex", Path.cwd())
                app_server._sync_runtime_thread_index = Mock(return_value=False)  # type: ignore[method-assign]
                self.assertTrue(app_server._sync_runtime_thread_to_history("thread-id"))
                target = history_home / source.relative_to(runtime_home)
                self.assertEqual(first_line, target.read_text(encoding="utf-8"))

                source.write_text(first_line + '{"type":"event_msg"}\n', encoding="utf-8")
                self.assertTrue(app_server._sync_runtime_thread_to_history("thread-id"))
                self.assertEqual(
                    first_line + '{"type":"event_msg"}\n',
                    target.read_text(encoding="utf-8"),
                )
            finally:
                if old_home is None:
                    os.environ.pop("CODEX_HOME", None)
                else:
                    os.environ["CODEX_HOME"] = old_home
                if old_runtime_home is None:
                    os.environ.pop("CODEX_REMOTE_APP_SERVER_HOME", None)
                else:
                    os.environ["CODEX_REMOTE_APP_SERVER_HOME"] = old_runtime_home

    async def test_runtime_rollout_never_overwrites_divergent_main_history(self) -> None:
        with tempfile.TemporaryDirectory() as history_directory, tempfile.TemporaryDirectory() as runtime_directory:
            history_home = Path(history_directory)
            runtime_home = Path(runtime_directory)
            relative = Path("sessions") / "2026" / "10" / "12" / "rollout-thread-id.jsonl"
            source = runtime_home / relative
            target = history_home / relative
            source.parent.mkdir(parents=True)
            target.parent.mkdir(parents=True)
            source.write_text('remote\nnew\n', encoding="utf-8")
            target.write_text('local\n', encoding="utf-8")
            old_home = os.environ.get("CODEX_HOME")
            old_runtime_home = os.environ.get("CODEX_REMOTE_APP_SERVER_HOME")
            try:
                os.environ["CODEX_HOME"] = str(history_home)
                os.environ["CODEX_REMOTE_APP_SERVER_HOME"] = str(runtime_home)
                app_server = CodexAppServer("codex", Path.cwd())
                app_server._sync_runtime_thread_index = Mock(return_value=False)  # type: ignore[method-assign]
                self.assertFalse(app_server._sync_runtime_rollout(source, runtime_home))
                self.assertEqual('local\n', target.read_text(encoding="utf-8"))
            finally:
                if old_home is None:
                    os.environ.pop("CODEX_HOME", None)
                else:
                    os.environ["CODEX_HOME"] = old_home
                if old_runtime_home is None:
                    os.environ.pop("CODEX_REMOTE_APP_SERVER_HOME", None)
                else:
                    os.environ["CODEX_REMOTE_APP_SERVER_HOME"] = old_runtime_home

    def test_runtime_index_registers_only_copied_web_sessions_without_overwriting_desktop_rows(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as history_directory, tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as runtime_directory:
            history_home = Path(history_directory)
            runtime_home = Path(runtime_directory)
            relative = Path("sessions") / "2026" / "10" / "12" / "rollout-web-thread.jsonl"
            source = runtime_home / relative
            target = history_home / relative
            source.parent.mkdir(parents=True)
            target.parent.mkdir(parents=True)
            source.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"id": "web-thread", "originator": "codex_remote_web"},
            }) + "\n", encoding="utf-8")
            shutil.copy2(source, target)
            schema = (
                "create table threads (id text primary key, rollout_path text not null, "
                "title text not null, originator text, history_mode text not null, project_id text)"
            )
            for home in (history_home, runtime_home):
                with closing(sqlite3.connect(home / "state_5.sqlite")) as connection, connection:
                    connection.execute(schema)
            with closing(sqlite3.connect(runtime_home / "state_5.sqlite")) as connection, connection:
                connection.execute(
                    "insert into threads values (?, ?, ?, ?, ?, ?)",
                    ("web-thread", str(source), "Web conversation", "codex_remote_web", "paginated", None),
                )

            old_home = os.environ.get("CODEX_HOME")
            old_runtime_home = os.environ.get("CODEX_REMOTE_APP_SERVER_HOME")
            try:
                os.environ["CODEX_HOME"] = str(history_home)
                os.environ["CODEX_REMOTE_APP_SERVER_HOME"] = str(runtime_home)
                app_server = CodexAppServer("codex", Path.cwd())
                target.write_text("divergent\n", encoding="utf-8")
                self.assertFalse(app_server._sync_runtime_thread_index(source, runtime_home))
                with closing(sqlite3.connect(history_home / "state_5.sqlite")) as connection:
                    self.assertIsNone(connection.execute("select id from threads where id = ?", ("web-thread",)).fetchone())
                shutil.copy2(source, target)
                self.assertTrue(app_server._sync_runtime_thread_index(source, runtime_home))
                with closing(sqlite3.connect(history_home / "state_5.sqlite")) as connection, connection:
                    self.assertEqual(
                        (str(target), "Web conversation", "codex_remote_web", "legacy"),
                        connection.execute(
                            "select rollout_path, title, originator, history_mode from threads where id = ?",
                            ("web-thread",),
                        ).fetchone(),
                    )
                    connection.execute("update threads set title = ? where id = ?", ("Desktop edit", "web-thread"))
                self.assertFalse(app_server._sync_runtime_thread_index(source, runtime_home))
                with closing(sqlite3.connect(history_home / "state_5.sqlite")) as connection:
                    self.assertEqual(
                        ("Desktop edit",),
                        connection.execute("select title from threads where id = ?", ("web-thread",)).fetchone(),
                    )

            finally:
                if old_home is None:
                    os.environ.pop("CODEX_HOME", None)
                else:
                    os.environ["CODEX_HOME"] = old_home
                if old_runtime_home is None:
                    os.environ.pop("CODEX_REMOTE_APP_SERVER_HOME", None)
                else:
                    os.environ["CODEX_REMOTE_APP_SERVER_HOME"] = old_runtime_home

    def test_thread_rollout_lookup_uses_filename_without_parsing_unrelated_history(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            codex_home = Path(directory)
            sessions = codex_home / "sessions" / "2026" / "10" / "12"
            sessions.mkdir(parents=True)
            unrelated = sessions / "rollout-unrelated.jsonl"
            unrelated.write_text("not-json\n", encoding="utf-8")
            expected = sessions / "rollout-2026-10-12-thread-id.jsonl"
            expected.write_text("also-not-json\n", encoding="utf-8")

            self.assertEqual(expected, CodexAppServer._find_thread_rollout(codex_home, "thread-id"))

    def test_runtime_history_backfill_only_syncs_remote_created_rollouts(self) -> None:
        with tempfile.TemporaryDirectory() as history_directory, tempfile.TemporaryDirectory() as runtime_directory:
            history_home = Path(history_directory)
            runtime_home = Path(runtime_directory)
            sessions = runtime_home / "sessions" / "2026" / "10" / "12"
            sessions.mkdir(parents=True)
            remote = sessions / "rollout-remote-id.jsonl"
            remote.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"id": "remote-id", "originator": "codex_remote_web"},
            }) + "\n", encoding="utf-8")
            imported = sessions / "rollout-imported-id.jsonl"
            imported.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"id": "imported-id", "originator": "codex_vscode"},
            }) + "\n", encoding="utf-8")
            old_home = os.environ.get("CODEX_HOME")
            old_runtime_home = os.environ.get("CODEX_REMOTE_APP_SERVER_HOME")
            try:
                os.environ["CODEX_HOME"] = str(history_home)
                os.environ["CODEX_REMOTE_APP_SERVER_HOME"] = str(runtime_home)
                app_server = CodexAppServer("codex", Path.cwd())
                app_server._sync_runtime_rollout = Mock(return_value=True)  # type: ignore[method-assign]
                app_server._sync_runtime_thread_index = Mock(return_value=False)  # type: ignore[method-assign]

                self.assertTrue(app_server._sync_runtime_created_history_to_main(runtime_home))
                app_server._sync_runtime_rollout.assert_called_once_with(remote, runtime_home)
                app_server._sync_runtime_thread_index.assert_called_once_with(remote, runtime_home)
            finally:
                if old_home is None:
                    os.environ.pop("CODEX_HOME", None)
                else:
                    os.environ["CODEX_HOME"] = old_home
                if old_runtime_home is None:
                    os.environ.pop("CODEX_REMOTE_APP_SERVER_HOME", None)
                else:
                    os.environ["CODEX_REMOTE_APP_SERVER_HOME"] = old_runtime_home

    async def test_shared_runtime_backfills_the_previous_windows_isolated_home(self) -> None:
        with tempfile.TemporaryDirectory() as legacy_directory:
            app_server = CodexAppServer("codex", Path.cwd())
            legacy_home = Path(legacy_directory).resolve()
            app_server._runtime_home = app_server._history_home
            app_server._legacy_runtime_home = legacy_home
            app_server._sync_runtime_created_history = AsyncMock()  # type: ignore[method-assign]

            app_server._schedule_runtime_history_sync()
            assert app_server._history_sync_task is not None
            await app_server._history_sync_task

            app_server._sync_runtime_created_history.assert_awaited_once_with(legacy_home)

    async def test_windows_websocket_runtime_does_not_fallback_on_codex_errors(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._use_windows_websocket = True
        app_server._start_runtime = AsyncMock(side_effect=CodexRuntimeError("Codex app-server 启动失败：网络超时"))  # type: ignore[method-assign]
        app_server._resolve_executable = Mock(return_value="codex.exe")  # type: ignore[method-assign]

        with self.assertRaisesRegex(CodexRuntimeError, "网络超时"):
            await app_server._ensure_started()

        app_server._start_runtime.assert_awaited_once_with("codex.exe")
        self.assertEqual(app_server._history_home, app_server._runtime_home)
        self.assertEqual("shared", app_server.status()["runtimeMode"])

    async def test_windows_websocket_transport_uses_loopback_and_capability_token(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._use_windows_websocket = True
        app_server._websocket_uri = "ws://127.0.0.1:45678"
        app_server._websocket_token = "local-secret"
        process = Mock(returncode=None)
        app_server._process = process
        fake_socket = AsyncMock()
        app_server._websocket_server_owned = False

        with (
            patch(
                "codex_remote.codex_app_server.websocket_connect",
                new_callable=AsyncMock,
                return_value=fake_socket,
            ) as connect,
            patch.object(app_server, "_read_websocket", new_callable=AsyncMock),
        ):
            await app_server._connect_windows_websocket(process)

        self.assertEqual(
            "ws://127.0.0.1:45678",
            connect.await_args.args[0],
        )
        self.assertEqual(
            {"Authorization": "Bearer local-secret"},
            connect.await_args.kwargs["additional_headers"],
        )
        self.assertIs(app_server._websocket, fake_socket)

    async def test_windows_runtime_starts_codex_with_hapi_websocket_transport(self) -> None:
        app_server = CodexAppServer("codex.exe", Path.cwd())
        app_server._use_windows_websocket = True
        child = Mock(returncode=None, stdin=None, wait=AsyncMock(return_value=0))
        child.stderr = asyncio.StreamReader()
        child.stderr.feed_eof()
        connected = asyncio.Event()
        requests: list[tuple[str, dict[str, object]]] = []

        async def fake_connect(process: object) -> None:
            app_server._websocket = AsyncMock()
            app_server._websocket_server_owned = True
            connected.set()

        async def fake_request(method: str, params: dict[str, object], timeout: float) -> dict[str, object]:
            requests.append((method, params))
            return {"ok": True}

        app_server._connect_windows_websocket = fake_connect  # type: ignore[method-assign]
        app_server._request = fake_request  # type: ignore[method-assign]
        with (
            patch.object(app_server, "_seed_runtime_database"),
            patch.object(app_server, "_app_server_environment", return_value={"CODEX_HOME": str(app_server._history_home)}),
            patch.object(app_server, "_free_loopback_port", new_callable=AsyncMock, return_value=43210),
            patch("codex_remote.codex_app_server.asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=child) as spawn,
        ):
            await app_server._start_runtime("codex.exe")

        self.assertTrue(connected.is_set())
        initialize = next(params for method, params in requests if method == "initialize")
        capabilities = initialize["capabilities"]
        assert isinstance(capabilities, dict)
        self.assertIs(capabilities["experimentalApi"], True)
        args = spawn.await_args.args
        kwargs = spawn.await_args.kwargs
        self.assertEqual(
            ["codex.exe", "app-server", "--listen", "ws://127.0.0.1:43210", "--ws-auth", "capability-token", "--ws-token-sha256"],
            list(args[:7]),
        )
        self.assertEqual(hashlib.sha256(app_server._websocket_token.encode()).hexdigest(), args[7])
        self.assertEqual(asyncio.subprocess.DEVNULL, kwargs["stdin"])
        self.assertEqual(asyncio.subprocess.DEVNULL, kwargs["stdout"])
        self.assertEqual(str(app_server._history_home), kwargs["env"]["CODEX_HOME"])
        assert app_server._websocket is not None
        await app_server._websocket.close()
        await app_server._cancel_io_tasks()
        app_server._process = None

    async def test_windows_node_cli_shutdown_stops_the_owned_process_tree(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._process_uses_node_shim = True
        process = Mock(pid=12345, returncode=None, wait=AsyncMock(return_value=0), terminate=Mock(), kill=Mock())
        killer = Mock(returncode=0, wait=AsyncMock(return_value=0))

        with (
            patch("codex_remote.codex_app_server.os.name", "nt"),
            patch(
                "codex_remote.codex_app_server.asyncio.create_subprocess_exec",
                new_callable=AsyncMock,
                return_value=killer,
            ) as spawn,
        ):
            await app_server._terminate_runtime_process(process)

        self.assertEqual(("taskkill.exe", "/PID", "12345", "/T", "/F"), spawn.await_args.args)
        process.terminate.assert_not_called()
        process.kill.assert_not_called()
    def test_windows_runtime_uses_path_codex_shim_before_managed_codex_executable(self) -> None:
        with tempfile.TemporaryDirectory() as home_directory:
            home = Path(home_directory)
            shim = home / "npm" / "codex.cmd"
            codex_script = shim.parent / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
            codex_script.parent.mkdir(parents=True)
            shim.parent.mkdir(parents=True, exist_ok=True)
            shim.touch()
            codex_script.touch()
            managed = home / "packages" / "app-server-daemon" / "current" / "bin" / "codex.exe"
            managed.parent.mkdir(parents=True)
            managed.touch()
            old_home = os.environ.get("CODEX_HOME")
            old_runtime_home = os.environ.pop("CODEX_REMOTE_APP_SERVER_HOME", None)
            try:
                os.environ["CODEX_HOME"] = str(home)
                app_server = CodexAppServer(str(shim), Path.cwd())
                app_server._use_windows_websocket = True
                self.assertEqual(str(codex_script), app_server._resolve_executable())
            finally:
                if old_home is None:
                    os.environ.pop("CODEX_HOME", None)
                else:
                    os.environ["CODEX_HOME"] = old_home
                if old_runtime_home is not None:
                    os.environ["CODEX_REMOTE_APP_SERVER_HOME"] = old_runtime_home

    def test_windows_npm_shim_resolves_to_node_script_without_combining_command_strings(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shim = root / "npm" / "codex.cmd"
            script = shim.parent / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
            script.parent.mkdir(parents=True)
            shim.parent.mkdir(parents=True, exist_ok=True)
            shim.touch()
            script.touch()
            old_home = os.environ.get("CODEX_HOME")
            old_local_app_data = os.environ.get("LOCALAPPDATA")
            old_runtime_home = os.environ.pop("CODEX_REMOTE_APP_SERVER_HOME", None)
            try:
                os.environ["CODEX_HOME"] = str(root / "codex-home")
                os.environ["LOCALAPPDATA"] = str(root / "local-app-data")
                app_server = CodexAppServer(str(shim), Path.cwd())
                app_server._use_windows_websocket = True

                self.assertEqual(str(script), app_server._resolve_executable())
                with patch("codex_remote.codex_app_server.shutil.which", return_value=None):
                    self.assertEqual(["node", str(script)], app_server._codex_command_prefix(str(script)))
            finally:
                if old_home is None:
                    os.environ.pop("CODEX_HOME", None)
                else:
                    os.environ["CODEX_HOME"] = old_home
                if old_local_app_data is None:
                    os.environ.pop("LOCALAPPDATA", None)
                else:
                    os.environ["LOCALAPPDATA"] = old_local_app_data
                if old_runtime_home is not None:
                    os.environ["CODEX_REMOTE_APP_SERVER_HOME"] = old_runtime_home

    async def test_list_threads_reads_all_pages_and_merges_disk_history(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._initialized = True
        app_server._process = Mock(returncode=None)
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

    async def test_list_threads_uses_disk_without_starting_offline_app_server(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._history.list_threads = Mock(return_value=[{"id": "disk-1", "name": "disk"}])
        app_server.request = AsyncMock(side_effect=AssertionError("app-server must not start"))

        self.assertEqual([{"id": "disk-1", "name": "disk"}], await app_server.list_threads())
        app_server.request.assert_not_awaited()

    async def test_read_thread_uses_disk_without_starting_offline_app_server(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        disk_thread = {"id": "disk-1", "sessionId": "disk-1", "turns": []}
        app_server._history.read_thread = Mock(return_value=disk_thread)
        app_server.request = AsyncMock(side_effect=AssertionError("app-server must not start"))

        self.assertEqual(disk_thread, await app_server.read_thread("disk-1"))
        app_server.request.assert_not_awaited()

    async def test_read_thread_prefers_main_history_to_stale_isolated_snapshot(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._initialized = True
        app_server._process = Mock(returncode=None)
        history_thread = {
            "id": "disk-1",
            "turns": [{"id": "turn-1", "items": [
                {"id": "user-1", "type": "userMessage", "content": [{"text": "hello"}]},
                {"id": "assistant-1", "type": "agentMessage", "text": "world"},
            ]}],
        }
        stale_runtime_thread = {
            "id": "disk-1",
            "turns": [{"id": "turn-1", "items": [
                {"id": "user-1", "type": "userMessage", "content": [{"text": "hello"}]},
            ]}],
        }
        app_server._history.read_thread = Mock(return_value=history_thread)
        app_server.request = AsyncMock(return_value={"thread": stale_runtime_thread})

        self.assertEqual(history_thread, await app_server.read_thread("disk-1"))
        app_server.request.assert_not_awaited()

    async def test_read_thread_uses_app_server_for_active_runtime_turn(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._initialized = True
        app_server._process = Mock(returncode=None)
        history_thread = {"id": "disk-1", "turns": [{"id": "turn-1", "items": []}]}
        live_thread = {"id": "disk-1", "turns": [{"id": "turn-2", "items": [
            {"id": "assistant-live", "type": "agentMessage", "text": "streaming"},
        ]}]}
        app_server._active_turn_ids["disk-1"] = "turn-2"
        app_server._history.read_thread = Mock(return_value=history_thread)
        app_server.request = AsyncMock(return_value={"thread": live_thread})

        self.assertEqual(live_thread, await app_server.read_thread("disk-1"))
        app_server.request.assert_awaited_once()

    async def test_status_only_read_uses_live_idle_status_over_stale_history(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._initialized = True
        app_server._process = Mock(returncode=None)
        app_server._history.read_thread = Mock(return_value={
            "id": "disk-1",
            "status": {"type": "inProgress"},
            "turns": [{"id": "old", "status": "inProgress"}],
        })
        app_server.request = AsyncMock(return_value={"thread": {"id": "disk-1", "status": {"type": "notLoaded"}}})

        result = await app_server.read_thread("disk-1", include_turns=False)

        self.assertEqual({"type": "notLoaded"}, result["status"])
        app_server.request.assert_awaited_once_with("thread/read", {"threadId": "disk-1", "includeTurns": False})

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
    async def test_set_thread_name_uses_the_codex_app_server_method(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server.request = AsyncMock(return_value={})

        await app_server.set_thread_name("thread-id", "Project notes")

        app_server.request.assert_awaited_once_with(
            "thread/name/set",
            {"threadId": "thread-id", "name": "Project notes"},
        )

    async def test_update_thread_approval_policy_waits_for_codex_confirmation(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        expected = {
            "approvalPolicy": {
                "granular": {
                    "sandbox_approval": False,
                    "rules": False,
                    "skill_approval": False,
                    "request_permissions": False,
                    "mcp_elicitations": True,
                },
            },
            "sandboxPolicy": {"type": "dangerFullAccess"},
        }

        async def request(method: str, params: dict[str, Any]) -> dict[str, Any]:
            if method == "thread/settings/update":
                self.assertEqual(params, {"threadId": "thread-id", **expected})
                await app_server._handle_message({
                    "method": "thread/settings/updated",
                    "params": {"threadId": "thread-id", "threadSettings": expected},
                })
                return {}
            raise AssertionError(f"Unexpected method: {method}")

        app_server.request = AsyncMock(side_effect=request)

        result = await app_server.update_thread_approval_policy("thread-id", "never")

        self.assertEqual(result, expected)
        self.assertEqual(app_server._thread_approval_policies["thread-id"], "never")
        app_server.request.assert_awaited_once()

    async def test_update_thread_approval_policy_skips_resume_for_a_loaded_thread(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._loaded_thread_workspaces["thread-id"] = Path.cwd()
        expected = {
            "approvalPolicy": "on-request",
            "sandboxPolicy": {"type": "workspaceWrite"},
        }

        async def request(method: str, params: dict[str, Any]) -> dict[str, Any]:
            self.assertEqual(method, "thread/settings/update")
            self.assertEqual(params, {"threadId": "thread-id", **expected})
            await app_server._handle_message({
                "method": "thread/settings/updated",
                "params": {"threadId": "thread-id", "threadSettings": expected},
            })
            return {}

        app_server.request = AsyncMock(side_effect=request)

        await app_server.update_thread_approval_policy("thread-id", "on-request")

        app_server.request.assert_awaited_once_with(
            "thread/settings/update",
            {"threadId": "thread-id", **expected},
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
                    "approvalPolicy": {
                        "granular": {
                            "sandbox_approval": False,
                            "rules": False,
                            "skill_approval": False,
                            "request_permissions": False,
                            "mcp_elicitations": True,
                        },
                    },
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
                    "approvalPolicy": {
                        "granular": {
                            "sandbox_approval": False,
                            "rules": False,
                            "skill_approval": False,
                            "request_permissions": False,
                            "mcp_elicitations": True,
                        },
                    },
                    "sandboxPolicy": {"type": "dangerFullAccess"},
                },
            ),
        )

    async def test_first_turn_does_not_resume_a_thread_started_in_the_same_workspace(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server.request = AsyncMock(side_effect=[
            {"thread": {"id": "thread-id", "cwd": str(Path.cwd())}},
            {"turn": {"id": "turn-id"}},
        ])
        app_server.resume_thread = AsyncMock()  # type: ignore[method-assign]
        app_server._start_workspace_change_watch = AsyncMock()  # type: ignore[method-assign]

        thread = await app_server.start_thread(cwd=Path.cwd())
        await app_server.start_turn(thread["id"], "hello", cwd=Path.cwd())

        app_server.resume_thread.assert_not_awaited()
        self.assertEqual(
            [call.args[0] for call in app_server.request.await_args_list],
            ["thread/start", "turn/start"],
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
        changes = asyncio.create_task(asyncio.sleep(0, result=WorkspaceSnapshot(frozenset(), {}, True)))
        old_watch = WorkspaceChangeWatch(asyncio.Event(), changes, WorkspaceSnapshot(frozenset(), {}, True), Path.cwd())
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
        new_watch = WorkspaceChangeWatch(asyncio.Event(), changes, old_watch.baseline, Path.cwd())
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
        changes = asyncio.create_task(asyncio.sleep(0, result=WorkspaceSnapshot(frozenset(), {}, True)))
        watch = WorkspaceChangeWatch(asyncio.Event(), changes, WorkspaceSnapshot(frozenset(), {}, True), Path.cwd())
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

        async def wait_for_stop() -> WorkspaceSnapshot:
            await asyncio.Event().wait()
            return WorkspaceSnapshot(frozenset(), {}, True)

        watch = WorkspaceChangeWatch(asyncio.Event(), asyncio.create_task(wait_for_stop()), WorkspaceSnapshot(frozenset(), {}, True), Path.cwd())
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

    async def test_delete_interrupts_an_active_turn_and_waits_for_completion(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._active_turn_ids["thread-id"] = "turn-id"
        app_server._prepare_runtime_thread = AsyncMock()  # type: ignore[method-assign]

        async def request(method: str, params: dict[str, Any], **_kwargs: object) -> dict[str, Any]:
            if method == "thread/read":
                status = "active" if sum(call.args[0] == "thread/read" for call in app_server.request.await_args_list) == 1 else "idle"
                return {"thread": {"id": "thread-id", "status": {"type": status}}}
            if method == "turn/interrupt":
                await app_server._handle_message({"method": "turn/completed", "params": {
                    "threadId": "thread-id", "turn": {"id": "turn-id", "status": "interrupted"},
                }})
                return {"interrupted": True}
            if method == "thread/delete":
                return {"deleted": True}
            raise AssertionError(f"Unexpected method: {method}")

        app_server.request = AsyncMock(side_effect=request)

        await app_server.delete_thread("thread-id")

        self.assertEqual(
            [call.args[0] for call in app_server.request.await_args_list],
            ["thread/read", "turn/interrupt", "thread/read", "thread/delete"],
        )
        self.assertEqual(app_server.request.await_args_list[1].args[1], {"threadId": "thread-id", "turnId": "turn-id"})

    async def test_delete_keeps_an_active_thread_if_interrupt_is_not_confirmed(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._active_turn_ids["thread-id"] = "turn-id"
        app_server._prepare_runtime_thread = AsyncMock()  # type: ignore[method-assign]

        async def request(method: str, _params: dict[str, Any], **_kwargs: object) -> dict[str, Any]:
            if method == "thread/read":
                return {"thread": {"id": "thread-id", "status": {"type": "active"}}}
            if method == "turn/interrupt":
                return {"interrupted": True}
            raise AssertionError(f"Unexpected method: {method}")

        app_server.request = AsyncMock(side_effect=request)

        with patch("codex_remote.codex_app_server.asyncio.sleep", new_callable=AsyncMock):
            with self.assertRaises(CodexThreadBusyError):
                await app_server.delete_thread("thread-id")

        methods = [call.args[0] for call in app_server.request.await_args_list]
        self.assertEqual(methods.count("turn/interrupt"), 1)
        self.assertNotIn("thread/delete", methods)

    async def test_delete_does_not_interrupt_an_idle_thread(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._prepare_runtime_thread = AsyncMock()  # type: ignore[method-assign]
        app_server.request = AsyncMock(return_value={"thread": {"id": "thread-id", "status": {"type": "idle"}}})

        await app_server.delete_thread("thread-id")

        self.assertEqual(
            [call.args[0] for call in app_server.request.await_args_list],
            ["thread/read", "thread/delete"],
        )

    async def test_delete_retries_when_codex_reports_busy_but_full_read_is_idle(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._prepare_runtime_thread = AsyncMock()  # type: ignore[method-assign]
        delete_attempts = 0

        async def request(method: str, params: dict[str, object], **_kwargs: object) -> dict[str, object]:
            nonlocal delete_attempts
            if method == "thread/read" and params.get("includeTurns") is False:
                return {"thread": {"id": "thread-id", "status": {"type": "idle"}}}
            if method == "thread/delete":
                delete_attempts += 1
                if delete_attempts == 1:
                    raise CodexRuntimeError("thread is busy: active turn")
                return {"deleted": True}
            if method == "thread/read" and params.get("includeTurns") is True:
                return {"thread": {
                    "id": "thread-id",
                    "status": {"type": "notLoaded"},
                    "turns": [],
                }}
            raise AssertionError(f"Unexpected method: {method}")

        app_server.request = AsyncMock(side_effect=request)

        await app_server.delete_thread("thread-id")

        self.assertEqual(2, delete_attempts)
        self.assertEqual(
            [call.args[0] for call in app_server.request.await_args_list],
            ["thread/read", "thread/delete", "thread/read", "thread/delete"],
        )

    async def test_delete_does_not_retry_busy_error_when_full_read_has_active_turn(self) -> None:
        app_server = CodexAppServer("codex", Path.cwd())
        app_server._prepare_runtime_thread = AsyncMock()  # type: ignore[method-assign]

        async def request(method: str, params: dict[str, object], **_kwargs: object) -> dict[str, object]:
            if method == "thread/read" and params.get("includeTurns") is False:
                return {"thread": {"id": "thread-id", "status": {"type": "idle"}}}
            if method == "thread/delete":
                raise CodexRuntimeError("thread is busy: active turn")
            if method == "thread/read" and params.get("includeTurns") is True:
                return {"thread": {
                    "id": "thread-id",
                    "status": {"type": "active"},
                    "turns": [{"id": "turn-id", "status": "inProgress"}],
                }}
            raise AssertionError(f"Unexpected method: {method}")

        app_server.request = AsyncMock(side_effect=request)

        with self.assertRaises(CodexThreadBusyError):
            await app_server.delete_thread("thread-id")

        self.assertEqual(
            [call.args[0] for call in app_server.request.await_args_list],
            ["thread/read", "thread/delete", "thread/read"],
        )

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
    def test_snapshot_comparison_detects_net_edits_including_new_and_removed_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            workspace = Path(temporary_directory)
            (workspace / "removed").mkdir()
            (workspace / "removed/old.txt").write_text("old\n")
            (workspace / "updated.txt").write_text("before\n")
            (workspace / "unchanged.txt").write_text("same\n")
            (workspace / "binary.dat").write_bytes(b"before\0")
            before = snapshot_workspace(workspace)
            (workspace / "removed/old.txt").unlink()
            (workspace / "removed").rmdir()
            (workspace / "added/nested").mkdir(parents=True)
            (workspace / "added/nested/new.txt").write_text("new\n")
            (workspace / "updated.txt").write_text("after\n")
            (workspace / "unchanged.txt").write_text("same\n")
            (workspace / "binary.dat").write_bytes(b"after changed\0")
            temporary = workspace / "ephemeral.txt"
            temporary.write_text("temporary")
            temporary.unlink()
            after = snapshot_workspace(workspace)

        self.assertEqual(workspace_snapshot_changes(before, after), {
            "removed/old.txt": "delete", "added/nested/new.txt": "add", "updated.txt": "update", "binary.dat": "update",
        })

    def test_incomplete_snapshot_does_not_invent_additions_or_deletions(self) -> None:
        before = WorkspaceSnapshot(frozenset({"first", "both"}), {"both": b"old"}, False)
        after = WorkspaceSnapshot(frozenset({"last", "both"}), {"both": b"new"}, False)
        self.assertEqual(workspace_snapshot_changes(before, after), {"both": "update"})

    def test_completed_diff_uses_captured_content_even_if_next_turn_edits_again(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            workspace = Path(temporary_directory)
            path = workspace / "edited.txt"
            path.write_text("before\n")
            before = snapshot_workspace(workspace)
            path.write_text("first turn\n")
            after = snapshot_workspace(workspace)
            path.write_text("second turn\n")
            entries = workspace_change_entries(workspace_snapshot_changes(before, after), workspace, before, after)
        self.assertIn("+first turn", entries[0]["diff"])
        self.assertNotIn("second turn", entries[0]["diff"])

    def test_snapshot_does_not_follow_directory_or_file_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            parent = Path(temporary_directory)
            workspace = parent / "workspace"
            workspace.mkdir()
            outside = parent / "outside"
            outside.mkdir()
            (outside / "not-project.txt").write_text("outside")
            try:
                (workspace / "directory-link").symlink_to(outside, target_is_directory=True)
                (workspace / "file-link.txt").symlink_to(outside / "not-project.txt")
            except OSError:
                self.skipTest("symlink creation not available")
            self.assertEqual(snapshot_workspace(workspace).paths, frozenset())

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
