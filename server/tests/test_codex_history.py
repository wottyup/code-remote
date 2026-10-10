from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from codex_remote.codex_history import CodexHistoryStore


class CodexHistoryStoreTests(unittest.TestCase):
    def test_lists_index_entries_and_reads_jsonl_turns(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            codex_home = Path(directory)
            session_dir = codex_home / "sessions" / "2026" / "10" / "01"
            session_dir.mkdir(parents=True)
            session_id = "01test-session"
            session_path = session_dir / "rollout-2026-10-01T12-00-00-01test-session.jsonl"
            lines = [
                {"timestamp": "2026-10-01T04:00:00Z", "type": "session_meta", "payload": {"session_id": session_id, "cwd": "F:\\\\1code", "originator": "codex_vscode"}},
                {"timestamp": "2026-10-01T04:00:01Z", "type": "event_msg", "payload": {"type": "item_completed", "turn_id": "turn-1", "item": {"type": "UserMessage", "id": "item-1", "content": [{"type": "text", "text": "你好"}]}}},
                {"timestamp": "2026-10-01T04:00:02Z", "type": "event_msg", "payload": {"type": "item_completed", "turn_id": "turn-1", "item": {"type": "AgentMessage", "id": "item-2", "content": [{"type": "Text", "text": "你好，我在。"}]}}},
                {"timestamp": "2026-10-01T04:00:03Z", "type": "event_msg", "payload": {"type": "task_complete", "turn_id": "turn-1", "completed_at": "2026-10-01T04:00:03Z"}},
            ]
            session_path.write_text("\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n", encoding="utf-8")
            (codex_home / "session_index.jsonl").write_text(json.dumps({"id": session_id, "thread_name": "测试会话", "updated_at": "2026-10-01T04:00:03Z"}, ensure_ascii=False) + "\n", encoding="utf-8")

            store = CodexHistoryStore(codex_home)
            threads = store.list_threads()
            self.assertEqual([session_id], [thread["id"] for thread in threads])
            self.assertEqual("测试会话", threads[0]["name"])

            thread = store.read_thread(session_id)
            self.assertIsNotNone(thread)
            assert thread is not None
            self.assertEqual("F:\\\\1code", thread["cwd"])
            self.assertEqual(1, len(thread["turns"]))
            self.assertEqual("userMessage", thread["turns"][0]["items"][0]["type"])
            self.assertEqual("agentMessage", thread["turns"][0]["items"][1]["type"])
            self.assertEqual("你好，我在。", thread["turns"][0]["items"][1]["text"])


if __name__ == "__main__":
    unittest.main()
