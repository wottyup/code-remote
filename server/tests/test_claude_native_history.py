from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from codex_remote.claude_native_history import scan_native_sessions


class ClaudeNativeHistoryScanTests(unittest.TestCase):
    def test_unchanged_native_session_is_not_reread(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            home = Path(temporary_directory) / ".claude"
            project = home / "projects" / "sample-project"
            project.mkdir(parents=True)
            session_id = str(uuid.uuid4())
            path = project / f"{session_id}.jsonl"
            path.write_text(json.dumps({
                "type": "user", "uuid": str(uuid.uuid4()),
                "message": {"content": "hello"},
                "timestamp": "2026-10-19T00:00:00Z",
                "cwd": str(project),
            }) + "\n", encoding="utf-8")
            stat = path.stat()

            with patch("codex_remote.claude_native_history.read_native_session") as read_session:
                sessions = scan_native_sessions(
                    home, project, {session_id: (str(path), stat.st_mtime_ns)}, set(),
                )

            self.assertEqual(sessions, [])
            read_session.assert_not_called()

    def test_new_native_session_is_imported(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            home = Path(temporary_directory) / ".claude"
            project = home / "projects" / "sample-project"
            project.mkdir(parents=True)
            session_id = str(uuid.uuid4())
            path = project / f"{session_id}.jsonl"
            path.write_text(json.dumps({
                "type": "user", "uuid": str(uuid.uuid4()),
                "message": {"content": "hello"},
                "timestamp": "2026-10-19T00:00:00Z",
                "cwd": str(project),
            }) + "\n", encoding="utf-8")

            sessions = scan_native_sessions(home, project, {}, set())

            self.assertEqual(len(sessions), 1)
            self.assertEqual(sessions[0]["session_id"], session_id)
            self.assertIn("hello", sessions[0]["messages_json"])


if __name__ == "__main__":
    unittest.main()
