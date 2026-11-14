"""Reconcile Claude's partial events and per-block assistant snapshots."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class _MessageText:
    blocks: dict[int, str] = field(default_factory=dict)
    completed: set[int] = field(default_factory=set)


class ClaudeReplyText:
    def __init__(self) -> None:
        self._messages: dict[str, _MessageText] = {}
        self._current: str | None = None
        self._seen_snapshots: set[str] = set()

    @property
    def text(self) -> str:
        return "\n\n".join(
            text for message in self._messages.values()
            for _, text in sorted(message.blocks.items()) if text
        )

    def _message(self, message_id: Any = None) -> _MessageText:
        if isinstance(message_id, str) and message_id:
            # Older partial events can omit message_start. Attach that pending
            # stream to its first named snapshot instead of showing it twice.
            if message_id not in self._messages and self._current and self._current.startswith("anonymous-"):
                self._messages[message_id] = self._messages.pop(self._current)
            self._current = message_id
        elif self._current is None:
            self._current = f"anonymous-{len(self._messages)}"
        return self._messages.setdefault(self._current, _MessageText())

    def consume(self, record: dict[str, Any]) -> str:
        if record.get("parent_tool_use_id"):
            return self.text
        kind = record.get("type")
        if kind == "stream_event":
            event = record.get("event")
            if not isinstance(event, dict):
                return self.text
            event_type = event.get("type")
            if event_type == "message_start":
                message = event.get("message")
                self._current = None
                self._message(message.get("id") if isinstance(message, dict) else None)
            elif event_type in {"content_block_start", "content_block_delta"}:
                index = event.get("index", 0)
                if not isinstance(index, int) or isinstance(index, bool) or index < 0:
                    return self.text
                message = self._message()
                if event_type == "content_block_start":
                    block = event.get("content_block")
                    if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                        message.blocks.setdefault(index, block["text"])
                else:
                    delta = event.get("delta")
                    if (isinstance(delta, dict) and delta.get("type") == "text_delta"
                            and isinstance(delta.get("text"), str) and index not in message.completed):
                        message.blocks[index] = message.blocks.get(index, "") + delta["text"]
        elif kind == "assistant":
            record_id = record.get("uuid")
            if isinstance(record_id, str):
                if record_id in self._seen_snapshots:
                    return self.text
                self._seen_snapshots.add(record_id)
            snapshot = record.get("message")
            content = snapshot.get("content") if isinstance(snapshot, dict) else None
            if not isinstance(content, list):
                return self.text
            message = self._message(snapshot.get("id"))
            for index, block in enumerate(content):
                if not isinstance(block, dict) or block.get("type") != "text" or not isinstance(block.get("text"), str):
                    continue
                text = block["text"]
                if len(content) == 1:
                    # CLI assistant records often contain only the completed
                    # block, even when thinking occupied earlier indexes.
                    matches = [key for key, old in message.blocks.items()
                               if old == text or (old and (text.startswith(old) or old.startswith(text)))]
                    pending = [key for key in message.blocks if key not in message.completed]
                    pending_matches = [key for key in matches if key in pending]
                    if pending_matches:
                        index = pending_matches[-1]
                    elif pending:
                        index = pending[-1]
                    elif matches:
                        index = matches[-1]
                    else:
                        index = max(message.blocks, default=-1) + 1
                old = message.blocks.get(index, "")
                # A late, shorter snapshot must not erase newer stream text.
                if not old.startswith(text):
                    message.blocks[index] = text
                message.completed.add(index)
        elif kind == "result" and record.get("is_error") is not True:
            result = record.get("result")
            if isinstance(result, str) and result.strip() and not self.text.rstrip().endswith(result.rstrip()):
                message = self._message()
                current_text = "\n\n".join(text for _, text in sorted(message.blocks.items()) if text)
                if not current_text or result.startswith(current_text):
                    message.blocks = {0: result}
                else:
                    self._current = f"result-{len(self._messages)}"
                    self._message().blocks[0] = result
        return self.text
