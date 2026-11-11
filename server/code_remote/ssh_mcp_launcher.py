"""Launch ssh-mcp with credentials kept out of Codex's per-thread config."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from .ssh_mcp_settings import SshMcpSettingsError, SshMcpSettingsStore


def main() -> int:
    state_directory = os.environ.get("CODE_REMOTE_SSH_MCP_STATE_DIRECTORY")
    if not state_directory:
        print("SSH MCP launcher configuration is missing.", file=sys.stderr)
        return 2

    store = SshMcpSettingsStore(Path(state_directory))
    try:
        if not store.list_profiles():
            print("SSH MCP settings are missing.", file=sys.stderr)
            return 2
        password_environment = store.runtime_password_environment()
    except SshMcpSettingsError as error:
        print(str(error), file=sys.stderr)
        return 2

    node = os.environ.get("CODE_REMOTE_SSH_MCP_NODE") or store._node_command()
    entrypoint_value = os.environ.get("CODE_REMOTE_SSH_MCP_ENTRYPOINT")
    entrypoint = Path(entrypoint_value) if entrypoint_value else store._entrypoint()
    if node is None or not entrypoint.is_file():
        print("SSH MCP runtime dependencies are unavailable.", file=sys.stderr)
        return 2

    environment = os.environ.copy()
    environment.update(password_environment)
    try:
        os.execvpe(node, [node, str(entrypoint), f"--config={store.config_path}"], environment)
    except OSError:
        print("Could not start the SSH MCP runtime.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
