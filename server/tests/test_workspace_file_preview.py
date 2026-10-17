from __future__ import annotations

import hashlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from codex_remote.app import (
    WORKSPACE_FILE_PREVIEW_MAX_BYTES,
    WORKSPACE_FILE_PREVIEW_MAX_LINES,
    WORKSPACE_TREE_MAX_ENTRIES,
    WorkspaceFileSaveRequest,
    create_app,
    workspace_base_for_cwd,
    workspace_directory_tree,
    workspace_file_preview,
    workspace_file_save,
)


class WorkspaceFilePreviewTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temporary_directory.name).resolve()

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_reads_utf8_text_and_returns_a_workspace_relative_path(self) -> None:
        source = self.workspace / "src" / "main.py"
        source.parent.mkdir()
        original = "\ufeffprint('你好')\n".encode("utf-8")
        source.write_bytes(original)

        result = workspace_file_preview(self.workspace, "src/main.py")

        self.assertEqual(result, {
            "path": "src/main.py",
            "content": "print('你好')\n",
            "size": len(original),
            "revision": hashlib.sha256(original).hexdigest(),
            "hasBom": True,
        })

    def test_saves_text_preserving_utf8_bom_and_crlf_line_endings(self) -> None:
        source = self.workspace / "notes.txt"
        original = b"\xef\xbb\xbffirst\r\nsecond\r\n"
        source.write_bytes(original)
        preview = workspace_file_preview(self.workspace, "notes.txt")

        saved = workspace_file_save(self.workspace, "notes.txt", "first\nupdated\n", str(preview["revision"]))

        expected = b"\xef\xbb\xbffirst\r\nupdated\r\n"
        self.assertEqual(source.read_bytes(), expected)
        self.assertEqual(saved["content"], "first\r\nupdated\r\n")
        self.assertEqual(saved["size"], len(expected))
        self.assertEqual(saved["revision"], hashlib.sha256(expected).hexdigest())

    def test_rejects_stale_revisions_without_overwriting_newer_content(self) -> None:
        source = self.workspace / "notes.txt"
        source.write_text("original", encoding="utf-8")
        revision = workspace_file_preview(self.workspace, "notes.txt")["revision"]
        source.write_text("changed elsewhere", encoding="utf-8")

        with self.assertRaises(HTTPException) as conflict:
            workspace_file_save(self.workspace, "notes.txt", "my edit", str(revision))

        self.assertEqual(conflict.exception.status_code, 409)
        self.assertEqual(source.read_text(encoding="utf-8"), "changed elsewhere")

    def test_rejects_unsafe_or_unsupported_save_targets(self) -> None:
        source = self.workspace / "inside.txt"
        source.write_text("inside", encoding="utf-8")
        revision = workspace_file_preview(self.workspace, "inside.txt")["revision"]

        with self.assertRaises(HTTPException) as traversal:
            workspace_file_save(self.workspace, "../outside.txt", "changed", str(revision))
        self.assertEqual(traversal.exception.status_code, 400)

        with self.assertRaises(HTTPException) as nul:
            workspace_file_save(self.workspace, "inside.txt", "bad\x00text", str(revision))
        self.assertEqual(nul.exception.status_code, 415)

        with self.assertRaises(HTTPException) as too_large:
            workspace_file_save(self.workspace, "inside.txt", "x" * (WORKSPACE_FILE_PREVIEW_MAX_BYTES + 1), str(revision))
        self.assertEqual(too_large.exception.status_code, 413)

        with self.assertRaises(HTTPException) as too_many_lines:
            workspace_file_save(self.workspace, "inside.txt", "\n" * (WORKSPACE_FILE_PREVIEW_MAX_LINES + 1), str(revision))
        self.assertEqual(too_many_lines.exception.status_code, 413)

    def test_rejects_symlinks_that_resolve_outside_the_workspace_for_saving(self) -> None:
        with tempfile.TemporaryDirectory() as outside_directory:
            outside = Path(outside_directory) / "outside.txt"
            outside.write_text("outside", encoding="utf-8")
            link = self.workspace / "linked.txt"
            try:
                link.symlink_to(outside)
            except (OSError, NotImplementedError):
                self.skipTest("symbolic links are unavailable")

            with self.assertRaises(HTTPException) as rejected:
                workspace_file_save(self.workspace, "linked.txt", "changed", "0" * 64)

            self.assertEqual(rejected.exception.status_code, 403)
            self.assertEqual(outside.read_text(encoding="utf-8"), "outside")

    def test_rejects_parent_traversal_and_absolute_paths(self) -> None:
        with self.assertRaises(HTTPException) as traversal:
            workspace_file_preview(self.workspace, "../outside.txt")
        with self.assertRaises(HTTPException) as absolute:
            workspace_file_preview(self.workspace, str(self.workspace / "inside.txt"))

        self.assertEqual(traversal.exception.status_code, 400)
        self.assertEqual(absolute.exception.status_code, 400)

    def test_reads_hidden_and_previously_ignored_paths(self) -> None:
        (self.workspace / ".env").write_text("secret", encoding="utf-8")
        ignored = self.workspace / "node_modules" / "package.json"
        ignored.parent.mkdir()
        ignored.write_text("{}", encoding="utf-8")

        self.assertEqual(workspace_file_preview(self.workspace, ".env")["content"], "secret")
        self.assertEqual(workspace_file_preview(self.workspace, "node_modules/package.json")["content"], "{}")

    def test_accepts_a_directory_outside_the_configured_project_parent(self) -> None:
        configured_workspace = self.workspace / "projects" / "current"
        configured_workspace.mkdir(parents=True)
        external_directory = self.workspace / "private" / "notes"
        external_directory.mkdir(parents=True)

        self.assertEqual(workspace_base_for_cwd(configured_workspace, str(external_directory)), external_directory.resolve())

    def test_directory_tree_includes_hidden_and_previously_ignored_entries(self) -> None:
        (self.workspace / ".env").write_text("secret", encoding="utf-8")
        (self.workspace / ".git").mkdir()
        (self.workspace / "node_modules").mkdir()
        (self.workspace / "dist").mkdir()

        tree = workspace_directory_tree(self.workspace)

        self.assertEqual({entry["name"] for entry in tree["entries"]}, {".env", ".git", "dist", "node_modules"})

    def test_directory_tree_paginates_without_losing_entries(self) -> None:
        for index in range(WORKSPACE_TREE_MAX_ENTRIES + 2):
            (self.workspace / f"file-{index:04}.txt").touch()

        first_page = workspace_directory_tree(self.workspace)
        second_page = workspace_directory_tree(self.workspace, offset=first_page["nextOffset"] or 0)

        self.assertEqual(len(first_page["entries"]), WORKSPACE_TREE_MAX_ENTRIES)
        self.assertTrue(first_page["truncated"])
        self.assertEqual(len(second_page["entries"]), 2)
        self.assertIsNone(second_page["nextOffset"])
        self.assertEqual(len(first_page["entries"]) + len(second_page["entries"]), WORKSPACE_TREE_MAX_ENTRIES + 2)

    def test_rejects_a_nonexistent_browser_directory(self) -> None:
        with self.assertRaises(HTTPException) as error:
            workspace_base_for_cwd(self.workspace, str(self.workspace / "missing"))

        self.assertEqual(error.exception.status_code, 404)

    def test_rejects_symlinks_that_resolve_outside_the_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as outside_directory:
            outside = Path(outside_directory) / "outside.txt"
            outside.write_text("outside", encoding="utf-8")
            link = self.workspace / "linked.txt"
            try:
                link.symlink_to(outside)
            except (OSError, NotImplementedError):
                self.skipTest("symbolic links are unavailable")

            with self.assertRaises(HTTPException) as error:
                workspace_file_preview(self.workspace, "linked.txt")

            self.assertEqual(error.exception.status_code, 403)

    def test_rejects_binary_and_non_utf8_files(self) -> None:
        (self.workspace / "binary.dat").write_bytes(b"hello\x00world")
        (self.workspace / "encoded.txt").write_bytes(b"\xff\xfe")

        for path in ("binary.dat", "encoded.txt"):
            with self.subTest(path=path), self.assertRaises(HTTPException) as error:
                workspace_file_preview(self.workspace, path)
            self.assertEqual(error.exception.status_code, 415)

    def test_rejects_files_over_byte_or_line_limits(self) -> None:
        (self.workspace / "large.txt").write_bytes(b"x" * (WORKSPACE_FILE_PREVIEW_MAX_BYTES + 1))
        (self.workspace / "many-lines.txt").write_bytes(b"x\n" * (WORKSPACE_FILE_PREVIEW_MAX_LINES + 1))

        for path in ("large.txt", "many-lines.txt"):
            with self.subTest(path=path), self.assertRaises(HTTPException) as error:
                workspace_file_preview(self.workspace, path)
            self.assertEqual(error.exception.status_code, 413)


class WorkspaceFileSaveApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        root = Path(self.temporary_directory.name).resolve()
        image_directory = root / "temporary-images"
        image_directory.mkdir()
        with (
            patch.dict(os.environ, {"CODEX_REMOTE_AUTH_FILE": str(root / "auth.json")}),
            patch("codex_remote.app.tempfile.mkdtemp", return_value=str(image_directory)),
        ):
            self.app = create_app(root)
        self.addCleanup(self.app.state.shared_state.close)
        self.addAsyncCleanup(self.app.state.claude_code.close)
        self.save_endpoint = next(
            route.endpoint
            for route in self.app.routes
            if getattr(route, "path", None) == "/api/v1/codex/workspace/file"
            and "POST" in getattr(route, "methods", set())
        )

    async def test_workspace_save_route_writes_to_the_selected_workspace(self) -> None:
        source = Path(self.temporary_directory.name) / "project.txt"
        source.write_text("before", encoding="utf-8")
        revision = workspace_file_preview(Path(self.temporary_directory.name), "project.txt")["revision"]

        result = await self.save_endpoint(WorkspaceFileSaveRequest(
            path="project.txt",
            content="after",
            revision=str(revision),
        ))

        self.assertEqual(source.read_text(encoding="utf-8"), "after")
        self.assertEqual(result["content"], "after")


if __name__ == "__main__":
    unittest.main()
