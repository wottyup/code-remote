from __future__ import annotations

import hmac
import os
import re
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import HTTPException

MAX_SEARCH_ENTRIES = 20_000
MAX_SEARCH_BYTES = 64 * 1024 * 1024
MAX_DISPLAY_MATCHES = 1_000
MAX_DISPLAY_FILES = 100
MAX_SELECTED_REPLACE_FILES = 100
MAX_SEARCH_SECONDS = 8
SKIP_DIRECTORIES = frozenset({
    ".git", ".hg", ".svn", "node_modules", ".pnpm-store", ".venv", "venv",
    "__pycache__", ".cache", ".gradle", ".next", ".nuxt", "dist", "build",
    ".devwisp", "artifacts",
})

ReadFile = Callable[[Path, str], dict[str, Any]]
SaveFile = Callable[[Path, str, str, str], dict[str, Any]]


class _SearchLimit(Exception):
    pass


class _WorkspaceTextScanner:
    def __init__(self, base: Path, read_file: ReadFile):
        self.base = base
        self.read_file = read_file
        self.deadline = time.monotonic() + MAX_SEARCH_SECONDS
        self.visited_entries = 0
        self.read_bytes = 0
        self.scanned_files = 0
        self.skipped_files = 0

    def check_budget(self) -> None:
        if time.monotonic() > self.deadline:
            raise _SearchLimit

    def __iter__(self):
        directories = [self.base]
        while directories:
            self.check_budget()
            directory = directories.pop()
            if directory.is_symlink() or not directory.resolve().is_relative_to(self.base):
                continue
            try:
                with os.scandir(directory) as iterator:
                    entries = []
                    for entry in iterator:
                        self.visited_entries += 1
                        if self.visited_entries > MAX_SEARCH_ENTRIES:
                            raise _SearchLimit
                        self.check_budget()
                        entries.append(entry)
                entries.sort(key=lambda entry: entry.name.casefold())
            except _SearchLimit:
                raise
            except OSError:
                self.skipped_files += 1
                continue

            for entry in entries:
                self.check_budget()
                try:
                    if entry.is_symlink():
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        if entry.name not in SKIP_DIRECTORIES:
                            directories.append(Path(entry.path))
                        continue
                    if not entry.is_file(follow_symlinks=False) or entry.name.startswith((".devwisp-", ".code-remote-")):
                        continue
                    self.scanned_files += 1
                    size = entry.stat(follow_symlinks=False).st_size
                    if size > 1024 * 1024:
                        self.skipped_files += 1
                        continue
                    if self.read_bytes + size > MAX_SEARCH_BYTES:
                        raise _SearchLimit
                    relative = Path(entry.path).relative_to(self.base).as_posix()
                    preview = self.read_file(self.base, relative)
                    actual_size = int(preview["size"])
                    if self.read_bytes + actual_size > MAX_SEARCH_BYTES:
                        raise _SearchLimit
                    self.read_bytes += actual_size
                    self.check_budget()
                except _SearchLimit:
                    raise
                except (OSError, ValueError, HTTPException):
                    self.skipped_files += 1
                    continue
                yield relative, preview


def _search_pattern(query: str, match_case: bool) -> re.Pattern[str]:
    if not query or len(query) > 1000 or any(character in query for character in "\r\n\x00"):
        raise HTTPException(400, "请输入不超过 1,000 个字符的单行查找内容。")
    return re.compile(re.escape(query), 0 if match_case else re.IGNORECASE)


def search_workspace(base: Path, query: str, match_case: bool, read_file: ReadFile) -> dict[str, Any]:
    pattern = _search_pattern(query, match_case)
    scanner = _WorkspaceTextScanner(base, read_file)
    result: dict[str, Any] = {
        "cwd": str(base), "files": [], "matchCount": 0, "fileCount": 0,
        "scannedFiles": 0, "skippedFiles": 0, "truncated": False, "displayTruncated": False,
    }
    displayed_matches = 0
    active_group: dict[str, Any] | None = None
    try:
        for relative, preview in scanner:
            active_group = None
            group: dict[str, Any] | None = None
            file_match_count = 0
            # Match the editor's LF view; preserve original content during replacement.
            content = str(preview["content"]).replace("\r\n", "\n").replace("\r", "\n")
            for line_number, line in enumerate(content.split("\n"), 1):
                scanner.check_budget()
                for match in pattern.finditer(line):
                    if file_match_count % 256 == 0:
                        scanner.check_budget()
                    file_match_count += 1
                    result["matchCount"] += 1
                    if file_match_count == 1:
                        result["fileCount"] += 1

                    can_display = displayed_matches < MAX_DISPLAY_MATCHES and (
                        group is not None or len(result["files"]) < MAX_DISPLAY_FILES
                    )
                    if not can_display:
                        result["displayTruncated"] = True
                        continue
                    if group is None:
                        group = {
                            "path": relative, "revision": preview["revision"], "matches": [],
                            "matchCount": 0, "complete": True,
                        }
                        result["files"].append(group)
                        active_group = group
                    group["matches"].append({
                        "line": line_number, "column": match.start() + 1,
                        "before": line[max(0, match.start() - 65):match.start()],
                        "text": match.group(), "after": line[match.end():match.end() + 100],
                    })
                    displayed_matches += 1
            if group is not None:
                group["matchCount"] = file_match_count
            active_group = None
            scanner.check_budget()
    except _SearchLimit:
        if active_group is not None:
            active_group["matchCount"] = file_match_count
            active_group["complete"] = False
        result["truncated"] = True
    result["files"].sort(key=lambda group: group["path"].casefold())
    result["scannedFiles"] = scanner.scanned_files
    result["skippedFiles"] = scanner.skipped_files
    return result


def replace_workspace(
    base: Path, query: str, replacement: str, match_case: bool, files: list[dict[str, Any]],
    read_file: ReadFile, save_file: SaveFile, validate_content: Callable[[dict[str, Any], str], bytes],
) -> dict[str, Any]:
    pattern = _search_pattern(query, match_case)
    if not files or len(files) > MAX_SELECTED_REPLACE_FILES or len({entry["path"] for entry in files}) != len(files):
        raise HTTPException(400, "替换文件列表无效，请重新查找。")
    prepared = []
    total_bytes = 0
    for entry in files:
        relative = entry["path"]
        current = read_file(base, relative)
        # Search never returns symlinks; do not accept one substituted after the search.
        candidate = base
        for part in Path(relative).parts:
            candidate = candidate / part
            if candidate.is_symlink():
                raise HTTPException(409, f"文件已变化，请重新查找：{relative}")
        if not hmac.compare_digest(str(current["revision"]), entry["revision"]):
            raise HTTPException(409, f"文件已变化，请重新查找：{relative}")
        source = str(current["content"])
        count = 0
        removed_bytes = 0
        for match in pattern.finditer(source):
            count += 1
            if count > entry["matchCount"]:
                break
            removed_bytes += len(match.group().encode("utf-8"))
        if count != entry["matchCount"]:
            raise HTTPException(409, f"匹配数量已变化，请重新查找：{relative}")
        try:
            estimated_size = len(source.encode("utf-8")) - removed_bytes + count * len(replacement.encode("utf-8"))
        except UnicodeEncodeError as error:
            raise HTTPException(422, "替换内容不是有效的 UTF-8 文本。") from error
        if estimated_size > 1024 * 1024:
            raise HTTPException(413, f"替换后文件超过 1 MiB：{relative}")
        content = pattern.sub(lambda _match: replacement, source)
        total_bytes += len(validate_content(current, content))
        if total_bytes > MAX_SEARCH_BYTES:
            raise HTTPException(413, "本次替换内容过多，请缩小查找范围。")
        prepared.append((relative, content, entry["revision"], count))

    return _save_prepared_replacements(base, prepared, save_file)


def replace_workspace_all(
    base: Path, query: str, replacement: str, match_case: bool, read_file: ReadFile,
    save_file: SaveFile, validate_content: Callable[[dict[str, Any], str], bytes],
) -> dict[str, Any]:
    pattern = _search_pattern(query, match_case)
    scanner = _WorkspaceTextScanner(base, read_file)
    prepared = []
    total_bytes = 0
    try:
        for relative, current in scanner:
            content, count = pattern.subn(lambda _match: replacement, str(current["content"]))
            scanner.check_budget()
            if count == 0:
                continue
            try:
                output = validate_content(current, content)
            except UnicodeEncodeError as error:
                raise HTTPException(422, "替换内容不是有效的 UTF-8 文本。") from error
            total_bytes += len(output)
            if total_bytes > MAX_SEARCH_BYTES:
                raise HTTPException(413, "本次替换内容超过安全处理范围；请缩小查找目录。")
            prepared.append((relative, content, str(current["revision"]), count))
            scanner.check_budget()
    except _SearchLimit as error:
        raise HTTPException(413, "目录扫描达到安全上限，本次未写入文件；请缩小查找范围后重试。") from error

    return _save_prepared_replacements(base, prepared, save_file)


def _save_prepared_replacements(
    base: Path, prepared: list[tuple[str, str, str, int]], save_file: SaveFile,
) -> dict[str, Any]:
    # Preflight all files first; save rechecks each revision immediately before writing.
    result: dict[str, Any] = {"paths": [], "matchCount": 0, "errors": []}
    for relative, content, revision, count in prepared:
        try:
            save_file(base, relative, content, revision)
            result["paths"].append(relative)
            result["matchCount"] += count
        except (HTTPException, OSError) as error:
            result["errors"].append({"path": relative, "message": str(error.detail) if isinstance(error, HTTPException) else "无法保存该文件"})
    return result
