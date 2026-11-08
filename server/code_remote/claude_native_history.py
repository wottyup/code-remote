"""Read Claude Code's local session files without changing them."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _timestamp(value: Any, fallback: str) -> str:
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.astimezone(timezone.utc).isoformat()
        except ValueError:
            pass
    return fallback


def _plain_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    return "\n".join(
        block["text"] for block in content
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
    ).strip()


def _summary_text(value: str, limit: int) -> str:
    return " ".join(value.split())[:limit]


def read_native_session(path: Path, fallback_cwd: Path) -> dict[str, Any] | None:
    """Project user and assistant text into the existing remote thread shape."""
    try:
        session_id = str(uuid.UUID(path.stem))
        stat = path.stat()
    except (ValueError, OSError):
        return None
    fallback_time = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
    messages: list[dict[str, Any]] = []
    assistant_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    current_turn_id: str | None = None
    cwd: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    first_user_text = ""
    last_text = ""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as source:
            for line in source:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(entry, dict) or entry.get("isSidechain") is True:
                    continue
                role = entry.get("type")
                if role not in {"user", "assistant"}:
                    continue
                message = entry.get("message")
                if not isinstance(message, dict):
                    continue
                text = _plain_text(message.get("content"))
                if not text:
                    continue
                timestamp = _timestamp(entry.get("timestamp"), fallback_time)
                if cwd is None and isinstance(entry.get("cwd"), str) and Path(entry["cwd"]).is_absolute():
                    cwd = entry["cwd"]
                if role == "user":
                    item_id = entry.get("uuid")
                    if not isinstance(item_id, str) or not item_id:
                        item_id = str(uuid.uuid5(uuid.UUID(session_id), str(len(messages))))
                    current_turn_id = item_id
                    messages.append({
                        "id": f"user-{item_id}", "role": "user", "text": text,
                        "createdAt": timestamp, "turnId": current_turn_id,
                    })
                    if not first_user_text:
                        first_user_text = text
                    if created_at is None:
                        created_at = timestamp
                elif current_turn_id:
                    message_id = message.get("id")
                    key = (current_turn_id, message_id if isinstance(message_id, str) and message_id else str(entry.get("uuid")))
                    existing = assistant_by_key.get(key)
                    if existing is not None:
                        old_text = existing["text"]
                        if text.startswith(old_text):
                            existing["text"] = text
                        elif not old_text.startswith(text) and text not in old_text:
                            existing["text"] = f"{old_text}\n\n{text}"
                        existing["completedAt"] = timestamp
                    else:
                        assistant = {
                            "id": f"assistant-{entry.get('uuid') or len(messages)}", "role": "assistant",
                            "text": text, "createdAt": timestamp, "completedAt": timestamp,
                            "turnId": current_turn_id, "status": "completed",
                        }
                        messages.append(assistant)
                        assistant_by_key[key] = assistant
                updated_at = timestamp
                last_text = text
    except OSError:
        return None
    if not first_user_text:
        return None
    return {
        "thread_id": f"claude:{session_id}",
        "session_id": session_id,
        "name": _summary_text(first_user_text, 72) or "Claude Code 对话",
        "preview": _summary_text(last_text, 400),
        "cwd": cwd or str(fallback_cwd),
        "created_at": created_at or fallback_time,
        "updated_at": updated_at or fallback_time,
        "messages_json": json.dumps(messages, ensure_ascii=False),
        "native_source": str(path),
        "native_mtime_ns": stat.st_mtime_ns,
    }


def scan_native_sessions(
    home: Path,
    fallback_cwd: Path,
    known: dict[str, tuple[str | None, int | None]],
    hidden: set[str],
) -> list[dict[str, Any]]:
    projects = home / "projects"
    if not projects.is_dir():
        return []
    sessions: list[dict[str, Any]] = []
    for path in projects.glob("*/*.jsonl"):
        if path.is_symlink() or not path.is_file():
            continue
        try:
            session_id = str(uuid.UUID(path.stem))
            modified = path.stat().st_mtime_ns
        except (ValueError, OSError):
            continue
        if session_id in hidden:
            continue
        previous = known.get(session_id)
        if previous is not None and (previous[0] is None or previous[1] == modified):
            continue
        result = read_native_session(path, fallback_cwd)
        if result is not None:
            sessions.append(result)
    return sessions
