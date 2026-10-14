"""Project native Codex records onto the fields the remote UI actually uses.

Apply this at the browser boundary only: queues and runtime consumers must keep
receiving the original events. In particular, tool output can be many MiB and
can appear under several aliases in a single native history item.
"""

from __future__ import annotations

import json
from typing import Any


def _pick(value: dict[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    return {key: value[key] for key in fields if key in value}


def _records(value: Any) -> list[dict[str, Any]]:
    return [entry for entry in value if isinstance(entry, dict)] if isinstance(value, list) else []


def browser_thread_summary(thread: dict[str, Any]) -> dict[str, Any]:
    result = _pick(thread, ("id", "name", "preview", "cwd", "createdAt", "updatedAt", "status", "historyRevision"))
    for key, limit in (("name", 240), ("preview", 400)):
        text = result.get(key)
        if isinstance(text, str) and len(text) > limit:
            result[key] = text[:limit - 1] + "…"
    return result


def _operation_paths(value: Any, depth: int = 0) -> list[dict[str, str]]:
    if depth > 4 or not isinstance(value, (dict, list)):
        return []
    paths: list[dict[str, str]] = []
    entries = value.items() if isinstance(value, dict) else enumerate(value)
    for key, entry in entries:
        if str(key).lower() in {
            "path", "filepath", "file_path", "filename", "target_path", "source_path",
            "imagepath", "image_path", "imagefile", "image_file",
        }:
            if isinstance(entry, str) and entry.strip():
                paths.append({"path": entry.strip()})
        elif isinstance(entry, (dict, list)):
            paths.extend(_operation_paths(entry, depth + 1))
        if len(paths) >= 8:
            break
    return paths[:8]


def browser_changes(changes: Any) -> Any:
    fields = ("path", "filePath", "filename", "move_path", "movePath", "kind", "type",
              "diff", "patch", "unified_diff", "unifiedDiff", "additions", "deletions")
    if isinstance(changes, list):
        return [_pick(change, fields) if isinstance(change, dict) else change for change in changes]
    if isinstance(changes, dict):
        return {path: _pick(change, fields) if isinstance(change, dict) else change for path, change in changes.items()}
    return changes


def _browser_command_actions(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    actions: list[dict[str, str]] = []
    for entry in value[:8]:
        if not isinstance(entry, dict):
            continue
        action_type = entry.get("type")
        if not isinstance(action_type, str) or not action_type:
            continue
        action = {"type": action_type[:40]}
        normalized_type = action_type.replace("-", "").replace("_", "").lower()
        if normalized_type == "read":
            fields = ("name", "path")
        elif normalized_type == "listfiles":
            fields = ("path",)
        elif normalized_type == "search":
            fields = ("query", "path")
        else:
            fields = ()
        action.update({key: entry[key][:220] for key in fields if isinstance(entry.get(key), str) and entry[key]})
        if action:
            actions.append(action)
    return actions


def browser_item(item: dict[str, Any]) -> dict[str, Any]:
    result = _pick(item, ("id", "type", "status", "createdAt", "created_at", "timestamp"))
    item_type = str(item.get("type", "")).replace("_", "").replace("-", "").lower()
    if item_type == "usermessage":
        result.update(_pick(item, ("content", "text")))
        if isinstance(result.get("content"), list):
            # Image enrichment writes name/data onto each content part. Keep
            # native history objects untouched so the next fingerprint remains
            # based on the original record, not a previous browser response.
            result["content"] = [dict(part) if isinstance(part, dict) else part for part in result["content"]]
    elif item_type == "agentmessage":
        result.update(_pick(item, ("text",)))
    elif item_type == "filechange":
        result["changes"] = browser_changes(item.get("changes", []))
    elif item_type == "imageview":
        paths = _operation_paths(item)
        if paths:
            result["paths"] = paths
    elif item_type == "commandexecution":
        result.update(_pick(item, ("command",)))
        command_actions = _browser_command_actions(item.get("commandActions") or item.get("command_actions"))
        if command_actions:
            result["commandActions"] = command_actions
    elif item_type in {"mcptoolcall", "dynamictoolcall", "collabagenttoolcall"}:
        result.update(_pick(item, ("server", "tool", "name", "namespace")))
        args = item.get("arguments", item.get("args", item.get("input")))
        if isinstance(args, str) and len(args) < 20_000:
            try:
                args = json.loads(args)
            except (ValueError, RecursionError):
                args = None
        paths = _operation_paths(args)
        safe_arguments: dict[str, Any] = {}
        if paths:
            safe_arguments["paths"] = paths
        if isinstance(args, dict):
            skill = next((args.get(key) for key in ("skill", "skill_name", "skillName")
                          if isinstance(args.get(key), str) and args[key].strip()), None)
            if skill:
                safe_arguments["skill"] = skill.strip()[:160]
        if safe_arguments:
            result["arguments"] = safe_arguments
    elif item_type == "websearch":
        result.update(_pick(item, ("query",)))
    return result


def browser_turn(turn: dict[str, Any], *, include_items: bool) -> dict[str, Any]:
    result = _pick(turn, ("id", "threadId", "status", "startedAt", "completedAt", "durationMs", "error"))
    if include_items:
        result["items"] = [browser_item(item) for item in _records(turn.get("items"))]
    return result


def browser_thread(thread: dict[str, Any]) -> dict[str, Any]:
    result = browser_thread_summary(thread)
    result["turns"] = [browser_turn(turn, include_items=True) for turn in _records(thread.get("turns"))]
    changes = thread.get("codexRemoteWorkspaceChanges")
    if isinstance(changes, dict):
        result["codexRemoteWorkspaceChanges"] = {turn_id: browser_changes(entries) for turn_id, entries in changes.items()}
    return result


_GLOBAL_NOTIFICATIONS = {"thread/name/updated", "thread/deleted", "turn/started", "turn/completed"}
_DETAIL_NOTIFICATIONS = {
    "item/started", "item/completed", "item/agentMessage/delta",
    "item/fileChange/patchUpdated", "turn/workspaceChanges", "turn/plan/updated",
    "reasoning/summaryTextDelta",
}


def browser_event(event: dict[str, Any], *, thread_id: str | None = None, filter_thread: bool = False) -> dict[str, Any] | None:
    if event.get("type") != "notification":
        # Approval requests and delivery receipts must retain their full data.
        return event
    method = event.get("method")
    if method not in _GLOBAL_NOTIFICATIONS | _DETAIL_NOTIFICATIONS:
        return None
    params = event.get("params")
    if not isinstance(params, dict):
        params = {}
    turn = params.get("turn")
    event_thread_id = params.get("threadId") or (turn.get("threadId") if isinstance(turn, dict) else None)
    if filter_thread and method in _DETAIL_NOTIFICATIONS and event_thread_id and event_thread_id != thread_id:
        return None
    result = _pick(params, ("threadId", "turnId", "itemId"))
    if method in {"turn/started", "turn/completed"} and isinstance(turn, dict):
        result["turn"] = browser_turn(turn, include_items=False)
    elif method in {"item/started", "item/completed"} and isinstance(params.get("item"), dict):
        result["item"] = browser_item(params["item"])
    elif method == "item/agentMessage/delta":
        result.update(_pick(params, ("delta",)))
    elif method in {"item/fileChange/patchUpdated", "turn/workspaceChanges"}:
        result["changes"] = browser_changes(params.get("changes", []))
    elif method == "thread/name/updated":
        result.update(_pick(params, ("threadName",)))
    return {"type": "notification", "method": method, "params": result}
