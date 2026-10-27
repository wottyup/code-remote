from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from codex_remote.app import create_app
from codex_remote.mcp_approvals import MCPApprovalStore
from codex_remote.retired_features import remove_retired_ssh_state


class RetiredSSHStateTests(unittest.TestCase):
    def test_cleanup_removes_only_retired_data_and_approvals_and_can_repeat(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("ssh-secrets", "ssh-broker"):
                (root / name).mkdir()
                (root / name / "old-entry").write_bytes(b"retired")
            for name in ("ssh-servers.json", "ssh-operations.sqlite3", "ssh-operations.sqlite3-wal", "ssh-operations.sqlite3-shm"):
                (root / name).write_bytes(b"retired")
            retained = root / "shared-state.sqlite3"
            retained.write_bytes(b"keep")
            approvals = MCPApprovalStore(root / "mcp-approvals.json")
            approvals.add("code_remote_ssh", "execute_command", "server")
            approvals.add("code_remote_ssh", "list_servers", "tool")
            other_grant = approvals.add("filesystem", "read_file", "tool")

            remove_retired_ssh_state(root, approvals)
            remove_retired_ssh_state(root, approvals)

            self.assertEqual({path.name for path in root.iterdir()}, {retained.name, approvals.path.name})
            self.assertEqual(b"keep", retained.read_bytes())
            self.assertEqual([other_grant], approvals.list())
            self.assertTrue(approvals.allows("filesystem", "read_file"))

    @unittest.skipIf(os.name == "nt", "Symlink creation requires privileges on Windows")
    def test_cleanup_unlinks_old_directory_symlinks_without_following_them(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            state.mkdir()
            system_ssh = root / ".ssh"
            system_ssh.mkdir()
            retained = system_ssh / "keep"
            retained.write_bytes(b"keep")
            (state / "ssh-secrets").symlink_to(system_ssh, target_is_directory=True)
            (state / "ssh-broker").symlink_to(root / "absent", target_is_directory=True)

            remove_retired_ssh_state(state, MCPApprovalStore(state / "mcp-approvals.json"))

            self.assertFalse((state / "ssh-secrets").is_symlink())
            self.assertFalse((state / "ssh-broker").is_symlink())
            self.assertEqual(b"keep", retained.read_bytes())


class AgentLocalExecutionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.enterContext(patch.dict(os.environ, {
            "CODEX_HOME": str(self.root / "codex-home"),
            "CODEX_REMOTE_APP_SERVER_HOME": "",
            "CLAUDE_CONFIG_DIR": str(self.root / "claude-home"),
            "CODEX_REMOTE_AUTH_FILE": str(self.root / "state" / "auth.json"),
            "CODEX_REMOTE_STATE_FILE": str(self.root / "state" / "shared-state.sqlite3"),
        }))
        # App creation must work without bubblewrap and with state inside the workspace.
        with patch("shutil.which", return_value=None):
            self.app = create_app(self.root)
        self.addCleanup(self.app.state.shared_state.close)
        self.addAsyncCleanup(self.app.state.codex.close)
        self.addAsyncCleanup(self.app.state.claude_code.close)

    async def test_app_has_no_ssh_routes_or_storage_and_keeps_generic_mcp_approvals(self) -> None:
        paths = {getattr(route, "path", "") for route in self.app.routes}
        self.assertFalse(any(path.startswith("/api/v1/ssh/") for path in paths))
        self.assertIn("/api/v1/mcp/approvals", paths)
        self.assertIn("/api/v1/codex/terminal", paths)
        self.assertFalse(any(path.name.startswith("ssh-") for path in (self.root / "state").iterdir()))
        self.app.state.mcp_approvals.add("filesystem", "read_file", "tool")
        self.assertTrue(self.app.state.codex._mcp_approval_store.allows("filesystem", "read_file"))

    async def test_codex_thread_start_and_resume_do_not_inject_connection_tools(self) -> None:
        server = self.app.state.codex
        server.request = AsyncMock(side_effect=[
            {"thread": {"id": "new-thread"}},
            {"thread": {"id": "existing-thread", "cwd": str(self.root)}},
        ])

        await server.start_thread(cwd=self.root)
        await server.resume_thread("existing-thread", cwd=self.root)

        self.assertEqual(server.request.await_args_list[0].args, (
            "thread/start", {"cwd": str(self.root), "serviceName": "codex_remote_web"},
        ))
        self.assertEqual(server.request.await_args_list[1].args, (
            "thread/resume", {"threadId": "existing-thread", "cwd": str(self.root)},
        ))

    async def test_codex_launches_directly_with_the_native_environment(self) -> None:
        server = self.app.state.codex
        server._use_windows_websocket = False
        server._request = AsyncMock(return_value={})
        server._write = AsyncMock()
        child = Mock(returncode=0, stdout=asyncio.StreamReader(), stderr=asyncio.StreamReader())
        with patch("codex_remote.codex_app_server.asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=child) as spawn:
            await server._start_runtime("codex")

        self.assertEqual(("codex", "app-server", "--listen", "stdio://"), spawn.await_args.args)
        self.assertEqual(self.root, spawn.await_args.kwargs["cwd"])
        self.assertEqual(os.environ.get("PATH"), spawn.await_args.kwargs["env"].get("PATH"))

    async def test_claude_launches_directly_for_new_and_resumed_turns(self) -> None:
        server = self.app.state.claude_code
        thread = await server.create_thread()
        for turn_index in range(2):
            output = asyncio.StreamReader()
            output.feed_data(json.dumps({"type": "system", "subtype": "init"}).encode() + b"\n")
            output.feed_eof()
            child = Mock(returncode=0, stdin=None, stdout=output, wait=AsyncMock(return_value=0))
            with (
                patch.object(server, "_executable", return_value="claude"),
                patch("codex_remote.claude_code.asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=child) as spawn,
            ):
                await server.start_turn(thread["id"], "hello")
                await asyncio.gather(*tuple(server._tasks.values()))

            args = spawn.await_args.args
            self.assertEqual("claude", args[0])
            self.assertNotIn("--mcp-config", args)
            self.assertIn("--session-id" if turn_index == 0 else "--resume", args)
            self.assertEqual(self.root, spawn.await_args.kwargs["cwd"])
