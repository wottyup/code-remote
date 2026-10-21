from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from codex_remote.app import resolve_default_workspace


class DefaultWorkspaceTests(unittest.TestCase):
    def test_defaults_to_the_project_parent_for_sibling_repositories(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_root = Path(directory) / "code-remote"

            self.assertEqual(Path(directory), resolve_default_workspace(project_root))

    def test_configured_workspace_overrides_the_platform_default(self) -> None:
        configured = Path("/custom/workspace").resolve()
        self.assertEqual(
            configured,
            resolve_default_workspace(Path("/project/remote"), configured=configured),
        )


if __name__ == "__main__":
    unittest.main()
