from __future__ import annotations

import asyncio
import os
import signal
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from devwisp.claude_code import ClaudeCodeServer


@unittest.skipUnless(os.name == "posix", "requires an executable fake Claude CLI")
class ClaudeExitRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_exited_cli_finishes_while_child_still_holds_stdout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            cli = workspace / "fake-claude"
            stop_file = workspace / "stop-child"
            child_exited = workspace / "child-exited"
            child_wrote = workspace / "child-wrote"
            child_pid = workspace / "child-pid"
            cli.write_text('''#!/usr/bin/env python3
import json, subprocess, sys
sys.stdin.read()
child = """import pathlib, sys, time
stop, done, start, wrote = map(pathlib.Path, sys.argv[1:])
deadline = time.monotonic() + 5
while not stop.exists() and time.monotonic() < deadline:
    if start.exists() and not wrote.exists():
        sys.stdout.buffer.write(b'x' * (1024 * 1024))
        sys.stdout.buffer.flush()
        wrote.touch()
    time.sleep(0.02)
done.touch()
"""
if "--resume" in sys.argv:
    open("resumed", "w").close()
else:
    process = subprocess.Popen([sys.executable, "-c", child, "stop-child", "child-exited", "start-child-write", "child-wrote"], stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    open("child-pid", "w").write(str(process.pid))
print(json.dumps({"type": "system", "subtype": "init"}), flush=True)
print(json.dumps({"type": "assistant", "message": {"id": "reply", "content": [{"type": "text", "text": "finished"}]}}), flush=True)
print(json.dumps({"type": "result", "result": "finished", "is_error": False}), flush=True)
''')
            cli.chmod(0o755)
            server = ClaudeCodeServer(str(cli), workspace, workspace / "claude.sqlite3", AsyncMock())
            thread = await server.create_thread()
            task = None
            create_subprocess = asyncio.create_subprocess_exec

            async def start_with_small_pipe(*args, **kwargs):
                kwargs["limit"] = 4096
                return await create_subprocess(*args, **kwargs)

            try:
                with patch("devwisp.claude_code.CLAUDE_DRAIN_GRACE_SECONDS", 0.2), patch(
                    "devwisp.claude_code.asyncio.create_subprocess_exec", side_effect=start_with_small_pipe,
                ):
                    await server.start_turn(thread["id"], "hello")
                    task = server._tasks[thread["id"]]
                    await asyncio.wait_for(asyncio.shield(task), 1.5)
                history = await server.read_thread(thread["id"])
                self.assertEqual(history["status"]["type"], "idle")
                self.assertEqual(history["turns"][-1]["status"], "completed")
                self.assertTrue(any(item.get("text") == "finished" for item in history["turns"][-1]["items"]))
                self.assertFalse(child_exited.exists(), "the background process must still be running")
                (workspace / "start-child-write").touch()
                for _ in range(100):
                    if child_wrote.exists():
                        break
                    await asyncio.sleep(0.02)
                self.assertTrue(child_wrote.exists(), "background output must not block on a full pipe")
                await server.start_turn(thread["id"], "continue")
                task = server._tasks[thread["id"]]
                await asyncio.wait_for(asyncio.shield(task), 1.5)
                self.assertTrue((workspace / "resumed").exists())
                history = await server.read_thread(thread["id"])
                self.assertEqual(history["turns"][-1]["status"], "completed")
            finally:
                stop_file.touch()
                if task:
                    await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 3)
                for _ in range(100):
                    if child_exited.exists():
                        break
                    await asyncio.sleep(0.02)
                if not child_exited.exists() and child_pid.exists():
                    try:
                        os.kill(int(child_pid.read_text()), signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                drains = tuple(server._stdout_drain_tasks)
                if drains:
                    await asyncio.wait_for(asyncio.gather(*drains, return_exceptions=True), 3)
                await server.close()
                await asyncio.sleep(0.05)
