"""Bounded fingerprints for incremental browser history responses.

Only fingerprints are retained here. Missing/evicted revisions transparently
fall back to a complete response; no client may apply a partial base it lacks.
"""

from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


@dataclass
class TurnFingerprint:
    signature: str
    items: dict[str, str]


@dataclass
class HistoryFingerprint:
    thread_id: str
    turns: dict[str, TurnFingerprint]
    workspace: dict[str, str]
    item_count: int


class BrowserHistorySync:
    def __init__(self, *, max_states: int = 32, max_items: int = 50_000) -> None:
        self._states: OrderedDict[str, HistoryFingerprint] = OrderedDict()
        self.max_states = max_states
        self.max_items = max_items

    def response(self, thread: dict[str, Any], since: str | None = None) -> dict[str, Any]:
        turns = thread.get("turns", [])
        workspace = thread.get("codexRemoteWorkspaceChanges", {})
        if not isinstance(thread.get("id"), str) or not isinstance(turns, list) or not isinstance(workspace, dict):
            return thread
        fingerprints: dict[str, TurnFingerprint] = {}
        for turn in turns:
            if not isinstance(turn, dict) or not isinstance(turn.get("items"), list):
                return thread
            turn_id = turn.get("id")
            if not isinstance(turn_id, str) or not turn_id or turn_id in fingerprints:
                return thread
            items: dict[str, str] = {}
            for item in turn["items"]:
                if not isinstance(item, dict):
                    return thread
                item_id = item.get("id")
                if not isinstance(item_id, str) or not item_id or item_id in items:
                    return thread
                items[item_id] = _digest(item)
            header = {key: value for key, value in turn.items() if key != "items"}
            fingerprints[turn_id] = TurnFingerprint(_digest([header, list(items.items())]), items)
        state = HistoryFingerprint(
            thread_id=thread["id"], turns=fingerprints,
            workspace={turn_id: _digest(changes) for turn_id, changes in workspace.items()},
            item_count=sum(len(turn.items) + 1 for turn in fingerprints.values()) + len(workspace),
        )
        if state.item_count > self.max_items:
            return thread
        revision = _digest([state.thread_id, [(key, turn.signature) for key, turn in state.turns.items()], state.workspace])
        previous = self._states.get(since) if since else None
        sync: dict[str, Any] = {"revision": revision}
        result = {**thread, "historySync": sync}
        if previous is not None and previous.thread_id == state.thread_id:
            changed_turns = []
            item_orders = {}
            for turn in turns:
                turn_id = turn["id"]
                old = previous.turns.get(turn_id)
                current = state.turns[turn_id]
                if old is not None and old.signature == current.signature:
                    continue
                changed_turns.append({**turn, "items": [
                    item for item in turn.get("items", [])
                    if old is None or old.items.get(item["id"]) != current.items[item["id"]]
                ]})
                item_orders[turn_id] = list(current.items)
            result["turns"] = changed_turns
            result["codexRemoteWorkspaceChanges"] = {
                turn_id: changes for turn_id, changes in workspace.items()
                if previous.workspace.get(turn_id) != state.workspace[turn_id]
            }
            sync.update({"baseRevision": since, "turnIds": list(state.turns),
                         "itemIds": item_orders, "workspaceTurnIds": list(state.workspace)})
        self._states.pop(revision, None)
        self._states[revision] = state
        retained_items = sum(entry.item_count for entry in self._states.values())
        while len(self._states) > self.max_states or retained_items > self.max_items:
            _, evicted = self._states.popitem(last=False)
            retained_items -= evicted.item_count
        return result
