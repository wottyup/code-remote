"""Bounded Codex activity snapshots suitable for room messages."""

from __future__ import annotations

import json
import re
from typing import Any

from .browser_payload import browser_item

MAX_ACTIVITY_BYTES = 60_000
MAX_ACTIVITY_ITEMS = 80
ALLOWED_TYPES = {
    "agentmessage", "commandexecution", "filechange", "mcptoolcall",
    "dynamictoolcall", "collabagenttoolcall", "websearch", "imageview",
    "imagegeneration", "subagentactivity",
}


def _limited(value: Any, limit: int) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _safe_command(value: Any) -> str:
    command = _limited(value, 1200)
    command = re.sub(r"(?i)(--?(?:token|password|passwd|api[-_]?key|secret|authorization|cookie)(?:=|\s+))\S+", r"\1[已隐藏]", command)
    command = re.sub(r"(?i)\bBearer\s+\S+", "Bearer [已隐藏]", command)
    command = re.sub(r"(?i)\b([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)=\S+", r"\1=[已隐藏]", command)
    return command


def project_activity(items: Any, state: str = "running") -> dict[str, Any]:
    """Keep browser-visible item details while bounding every relayed snapshot."""
    projected: list[dict[str, Any]] = []
    budget = MAX_ACTIVITY_BYTES - 100
    for raw in reversed((items if isinstance(items, list) else [])[-MAX_ACTIVITY_ITEMS:]):
        if not isinstance(raw, dict):
            continue
        item_type = str(raw.get("type", "")).replace("_", "").replace("-", "").lower()
        if item_type not in ALLOWED_TYPES:
            continue
        item = browser_item(raw)
        if item_type == "agentmessage":
            item.pop("text", None)
            length = raw.get("length")
            item["length"] = len(raw["text"]) if isinstance(raw.get("text"), str) else max(0, min(length, 500_000)) if isinstance(length, int) else 0
        elif item_type == "commandexecution":
            item["command"] = _safe_command(item.get("command"))
        elif item_type == "filechange":
            changes = item.get("changes")
            def trim_change(change: Any) -> Any:
                if not isinstance(change, dict):
                    return change
                return {**change, **{key: _limited(change[key], 4000) for key in
                        ("diff", "patch", "unified_diff", "unifiedDiff") if key in change}}
            if isinstance(changes, list):
                item["changes"] = [trim_change(change) for change in changes[:20]]
            elif isinstance(changes, dict):
                item["changes"] = {path: trim_change(change) for path, change in list(changes.items())[:20]}
        encoded = json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > budget and item_type == "filechange":
            changes = item.get("changes")
            def without_diff(change: Any) -> Any:
                return {key: value for key, value in change.items() if key not in
                        {"diff", "patch", "unified_diff", "unifiedDiff"}} if isinstance(change, dict) else change
            if isinstance(changes, list):
                item["changes"] = [without_diff(change) for change in changes]
            elif isinstance(changes, dict):
                item["changes"] = {path: without_diff(change) for path, change in changes.items()}
            encoded = json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > budget:
            continue
        projected.append(item)
        budget -= len(encoded.encode("utf-8"))
    projected.reverse()
    return {"state": state if state in {"running", "completed", "failed"} else "running", "items": projected}


def upsert_activity_item(items: list[dict[str, Any]], raw: Any) -> None:
    if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
        return
    for index, existing in enumerate(items):
        if existing.get("id") == raw["id"]:
            items[index] = dict(raw)
            return
    items.append(dict(raw))
    if len(items) > MAX_ACTIVITY_ITEMS:
        del items[:-MAX_ACTIVITY_ITEMS]
