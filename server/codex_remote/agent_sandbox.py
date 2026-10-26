"""Linux mount and process isolation for AI CLIs and their child tools."""

from __future__ import annotations

import shutil
import sys
from pathlib import Path


SANDBOX_BROKER_SOCKET = "/run/code-remote-ssh/broker.sock"


class AgentSandbox:
    def __init__(self, workspace: Path, state_directory: Path, broker_directory: Path,
                 attachment_directories: tuple[Path, ...], writable_homes: tuple[Path, ...]) -> None:
        self.workspace = workspace.resolve()
        self.state_directory = state_directory.resolve()
        self.broker_directory = broker_directory.resolve()
        self.attachment_directories = tuple(path.resolve() for path in attachment_directories)
        self.writable_homes = tuple(path.resolve() for path in writable_homes)
        self.linux = sys.platform.startswith("linux")
        self.bwrap = shutil.which("bwrap") if self.linux else None
        if self.linux and not self.bwrap:
            raise RuntimeError("AI 凭据隔离需要 bubblewrap（bwrap）；请安装后重启 Code Remote。")
        if self.linux and self.state_directory.is_relative_to(self.workspace):
            raise RuntimeError("Code Remote 状态目录不能位于 AI 工作区内，否则无法隔离 SSH 凭据。")
        if self.linux and not self.broker_directory.is_relative_to(self.state_directory):
            raise RuntimeError("SSH 代理目录必须位于受保护的状态目录内。")
        if self.linux and any(path.is_relative_to(self.state_directory) for path in self.writable_homes):
            raise RuntimeError("AI 可写目录不能位于 Code Remote 状态目录内。")

    def wrap(self, command: list[str], *, cwd: Path) -> list[str]:
        if not self.linux:
            return command
        assert self.bwrap is not None
        args = [
            self.bwrap, "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
            "--die-with-parent", "--new-session", "--ro-bind", "/", "/",
        ]
        # The agent may edit the selected workspace, while the rest of the host is read-only.
        for path in (self.workspace, *self.writable_homes):
            if path.is_dir():
                args.extend(("--bind", str(path), str(path)))
        # A fresh /proc hides the parent process and its file descriptors. /run holds only
        # the broker socket; the state directory itself remains invisible.
        args.extend(("--tmpfs", "/run", "--tmpfs", "/tmp", "--tmpfs", "/var/tmp",
                     "--proc", "/proc", "--dev", "/dev",
                     "--tmpfs", str(self.state_directory)))
        # Never attach to an unsandboxed Codex daemon through its host sockets.
        socket_directories = {
            home / name for home in self.writable_homes
            for name in ("app-server-control", "ipc")
        }
        for socket_directory in sorted(socket_directories):
            if socket_directory.is_dir():
                args.extend(("--tmpfs", str(socket_directory)))
        for path in self.attachment_directories:
            if path.is_dir():
                args.extend(("--ro-bind", str(path), str(path)))
        args.extend(("--ro-bind", str(self.broker_directory), "/run/code-remote-ssh",
                     "--chdir", str(cwd), "--", *command))
        return args
