"""Remove app-owned data left by retired features before starting AI processes."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from .mcp_approvals import MCPApprovalError, MCPApprovalStore

logger = logging.getLogger(__name__)

_RETIRED_SSH_MCP_SERVERS = frozenset({"code_remote_ssh", "code-remote-ssh", "ssh-mcp", "ssh_mcp"})


def remove_retired_ssh_state(state_directory: Path, approvals: MCPApprovalStore) -> None:
    """Delete only the retired built-in SSH feature's files, without reading secrets."""
    try:
        for name in ("ssh-secrets", "ssh-broker"):
            path = state_directory / name
            if path.is_symlink():
                path.unlink()
            elif path.exists():
                shutil.rmtree(path)
        for name in ("ssh-servers.json", "ssh-operations.sqlite3", "ssh-operations.sqlite3-wal", "ssh-operations.sqlite3-shm"):
            (state_directory / name).unlink(missing_ok=True)
    except OSError as error:
        raise RuntimeError("无法清理已移除的 SSH 功能数据，请检查 Code Remote 用户数据目录的权限。") from error

    try:
        for grant in approvals.list():
            if grant["serverName"] in _RETIRED_SSH_MCP_SERVERS:
                approvals.revoke(grant["id"])
    except (MCPApprovalError, OSError):
        # An unrelated damaged approval file must not prevent the app from starting.
        logger.warning("Could not remove retired SSH MCP approvals")
