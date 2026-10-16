#!/usr/bin/env python3
"""Activate a backend update after all local Codex/Claude turns finish."""

from __future__ import annotations

import argparse
import os
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "server"))

from codex_remote.codex_history import CodexHistoryStore  # noqa: E402


ACTIVE_STATUSES = {"active", "inProgress", "running", "started"}
CODEX_HOME = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()
CLAUDE_DATABASE = CODEX_HOME / "codex-remote" / "claude-code.sqlite3"


def service_pid(unit: str) -> int:
    result = subprocess.run(
        ["systemctl", "show", unit, "--property=MainPID", "--value"],
        capture_output=True, text=True, check=True, timeout=10,
    )
    return int(result.stdout.strip() or "0")


def active_turns() -> list[str]:
    history = CodexHistoryStore(CODEX_HOME)
    with sqlite3.connect(f"file:{(CODEX_HOME / 'state_5.sqlite').as_posix()}?mode=ro", uri=True, timeout=5) as database:
        thread_ids = [row[0] for row in database.execute("SELECT id FROM threads")]
    active = []
    for thread_id in thread_ids:
        thread = history.read_thread(thread_id, tail_turns=1)
        status = thread.get("status") if isinstance(thread, dict) else None
        if isinstance(status, dict) and status.get("type") in ACTIVE_STATUSES:
            active.append(thread_id)
    if CLAUDE_DATABASE.is_file():
        with sqlite3.connect(f"file:{CLAUDE_DATABASE.as_posix()}?mode=ro", uri=True, timeout=5) as database:
            active.extend(row[0] for row in database.execute(
                "SELECT thread_id FROM claude_threads WHERE running_turn_id IS NOT NULL AND running_turn_id != ''"
            ))
    return active


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--unit", default="codex-remote.service")
    parser.add_argument("--expected-pid", type=int, required=True)
    parser.add_argument("--wait-seconds", type=int, default=1800)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()

    if args.check_only:
        print(f"active_turn_count={len(active_turns())}")
        return

    deadline = time.monotonic() + args.wait_seconds
    while time.monotonic() < deadline:
        if service_pid(args.unit) != args.expected_pid:
            print("Service changed before activation; skipping restart.")
            return
        if not active_turns():
            time.sleep(2)
            if service_pid(args.unit) == args.expected_pid and not active_turns():
                subprocess.run(["systemctl", "restart", args.unit], check=True, timeout=90)
                for attempt in range(30):
                    try:
                        with urllib.request.urlopen("http://127.0.0.1:18766/health", timeout=3) as response:
                            if response.status == 200:
                                break
                    except OSError:
                        pass
                    time.sleep(1)
                else:
                    raise RuntimeError("Backend did not become healthy after restart")
                print("Backend update activated after all turns completed.")
                return
        time.sleep(3)
    raise TimeoutError("A turn remained active; backend was not restarted.")


if __name__ == "__main__":
    main()
