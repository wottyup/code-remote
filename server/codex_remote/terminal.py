from __future__ import annotations

import asyncio
import errno
import hashlib
import logging
import os
import shutil
import signal
import struct
import time
from contextlib import suppress
from pathlib import Path

logger = logging.getLogger(__name__)

TMUX_SOCKET_NAME = "codex-remote"
TMUX_SESSION_PREFIX = "codex-remote-"
TMUX_KEEPER_SESSION_NAME = "codex-remote-keeper"
TMUX_LAST_USED_OPTION = "@codex_remote_last_used"
TMUX_HISTORY_LIMIT = 5_000
TMUX_IDLE_TIMEOUT_SECONDS = 30 * 60
TMUX_MAX_DETACHED_SESSIONS = 10
TMUX_CLEANUP_INTERVAL_SECONDS = 60


def tmux_session_name_for_thread(thread_id: str) -> str:
    digest = hashlib.sha256(thread_id.encode("utf-8")).hexdigest()[:32]
    return f"{TMUX_SESSION_PREFIX}{digest}"


async def _run_tmux(*arguments: str, check: bool = True) -> str:
    executable = shutil.which("tmux")
    if not executable:
        raise RuntimeError("本机未安装 tmux，无法保留终端会话。请安装 tmux 后重启 Codex Remote。")
    environment = os.environ.copy()
    environment.pop("TMUX", None)
    process = await asyncio.create_subprocess_exec(
        executable,
        "-L",
        TMUX_SOCKET_NAME,
        *arguments,
        env=environment,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=5)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise RuntimeError("tmux 命令超时。")
    output = stdout.decode("utf-8", errors="replace")
    if check and process.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(detail or "tmux 命令执行失败。")
    return output


async def _set_tmux_last_used(session_name: str, timestamp: int | None = None) -> None:
    await _run_tmux(
        "set-option",
        "-t",
        session_name,
        TMUX_LAST_USED_OPTION,
        str(timestamp if timestamp is not None else int(time.time())),
    )


async def cleanup_tmux_sessions(protected_session_names: set[str] | None = None) -> None:
    if not shutil.which("tmux"):
        return
    protected = protected_session_names or set()
    now = int(time.time())
    try:
        listing = await _run_tmux(
            "list-sessions",
            "-F",
            f"#{{session_name}}|#{{session_attached}}|#{{{TMUX_LAST_USED_OPTION}}}",
            check=False,
        )
    except (OSError, RuntimeError) as error:
        logger.warning("Could not inspect tmux terminal sessions: %s", error)
        return

    detached: list[tuple[int, str]] = []
    for row in listing.splitlines():
        fields = row.split("|", 2)
        if len(fields) != 3:
            continue
        session_name, attached_text, last_used_text = fields
        if not session_name.startswith(TMUX_SESSION_PREFIX) or session_name == TMUX_KEEPER_SESSION_NAME:
            continue
        try:
            attached = int(attached_text)
        except ValueError:
            attached = 0
        if attached > 0 or session_name in protected:
            with suppress(OSError, RuntimeError):
                await _set_tmux_last_used(session_name, now)
            continue

        try:
            last_used = int(last_used_text)
        except ValueError:
            last_used = now
            with suppress(OSError, RuntimeError):
                await _set_tmux_last_used(session_name, last_used)
        if now - last_used >= TMUX_IDLE_TIMEOUT_SECONDS:
            with suppress(OSError, RuntimeError):
                await _run_tmux("kill-session", "-t", session_name)
            continue
        detached.append((last_used, session_name))

    detached.sort()
    for _, session_name in detached[:-TMUX_MAX_DETACHED_SESSIONS]:
        with suppress(OSError, RuntimeError):
            await _run_tmux("kill-session", "-t", session_name)


class TerminalSession:
    """One interactive shell attached to a browser terminal websocket."""

    def __init__(self, cwd: Path, columns: int, rows: int, thread_id: str | None = None) -> None:
        self.cwd = cwd
        self.columns = self._bounded_dimension(columns, 100, 20, 300)
        self.rows = self._bounded_dimension(rows, 30, 5, 120)
        self.argv = self._shell_argv()
        self.shell_name = Path(self.argv[0]).name
        self.tmux_session_name = (
            tmux_session_name_for_thread(thread_id)
            if thread_id and os.name != "nt"
            else None
        )
        self._master_fd: int | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._windows_process: object | None = None
        self._closed = False

    @staticmethod
    def _bounded_dimension(value: int, default: int, minimum: int, maximum: int) -> int:
        if isinstance(value, bool) or not isinstance(value, int):
            return default
        return max(minimum, min(maximum, value))

    @staticmethod
    def _shell_argv() -> list[str]:
        if os.name == "nt":
            shell = shutil.which("pwsh.exe") or shutil.which("pwsh")
            if shell:
                return [shell, "-NoLogo", "-NoExit"]
            shell = shutil.which("powershell.exe") or shutil.which("powershell")
            if shell:
                return [shell, "-NoLogo", "-NoExit"]
            return [os.environ.get("COMSPEC", "cmd.exe")]

        configured = os.environ.get("SHELL", "")
        shell = shutil.which(configured) if configured else None
        shell = shell or shutil.which("bash") or shutil.which("zsh") or "/bin/sh"
        return [shell, "-i"]

    @classmethod
    async def create(
        cls,
        cwd: Path,
        columns: int = 100,
        rows: int = 30,
        thread_id: str | None = None,
    ) -> TerminalSession:
        session = cls(cwd, columns, rows, thread_id)
        try:
            if os.name == "nt":
                await session._start_windows()
            else:
                await session._start_posix()
        except Exception:
            await session.close()
            raise
        return session

    @property
    def persistent(self) -> bool:
        return self.tmux_session_name is not None

    def _environment(self) -> dict[str, str]:
        environment = os.environ.copy()
        environment["TERM"] = "xterm-256color"
        environment["COLORTERM"] = "truecolor"
        return environment

    async def _start_posix(self) -> None:
        import fcntl
        import pty
        import termios

        master_fd, slave_fd = pty.openpty()
        self._master_fd = master_fd
        try:
            fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, self.columns, 0, 0))
            environment = self._environment()
            if self.tmux_session_name:
                executable = shutil.which("tmux")
                if not executable:
                    raise RuntimeError("本机未安装 tmux，无法保留终端会话。请安装 tmux 后重启 Codex Remote。")
                environment.pop("TMUX", None)
                argv = [
                    executable,
                    "-L",
                    TMUX_SOCKET_NAME,
                    "-u",
                    "new-session",
                    "-A",
                    "-s",
                    self.tmux_session_name,
                    "-c",
                    str(self.cwd),
                    "-x",
                    str(self.columns),
                    "-y",
                    str(self.rows),
                ]
                with suppress(OSError, RuntimeError):
                    await _set_tmux_last_used(self.tmux_session_name)
            else:
                argv = self.argv
            self._process = await asyncio.create_subprocess_exec(
                *argv,
                cwd=str(self.cwd),
                env=environment,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                start_new_session=True,
            )
            if self.tmux_session_name:
                await _run_tmux(
                    "set-window-option",
                    "-t",
                    self.tmux_session_name,
                    "history-limit",
                    str(TMUX_HISTORY_LIMIT),
                )
                await _run_tmux("set-option", "-t", self.tmux_session_name, "mouse", "on")
                await _set_tmux_last_used(self.tmux_session_name)
        except Exception:
            if self._process is not None and self._process.returncode is None:
                self._process.kill()
                await self._process.wait()
                self._process = None
            with suppress(OSError):
                os.close(master_fd)
            self._master_fd = None
            raise
        finally:
            os.close(slave_fd)

    async def _start_windows(self) -> None:
        try:
            from winpty import PtyProcess
        except ImportError as error:
            raise RuntimeError("Windows 本机终端依赖 pywinpty，请重新安装 server/requirements.txt。") from error

        # pywinpty's native blocking reader can hold the GIL when the
        # terminal has no output, preventing unrelated API requests.
        os.environ["PYWINPTY_BLOCK"] = "0"
        self._windows_process = await asyncio.to_thread(
            PtyProcess.spawn,
            self.argv,
            cwd=str(self.cwd),
            env=self._environment(),
            dimensions=(self.rows, self.columns),
        )

    async def read(self, size: int = 65_536) -> bytes:
        if self._closed:
            return b""
        if self._windows_process is not None:
            process = self._windows_process
            try:
                output = await asyncio.to_thread(process.read, size)  # type: ignore[attr-defined]
            except (EOFError, OSError, ValueError):
                return b""
            return output.encode("utf-8", errors="replace") if isinstance(output, str) else bytes(output)

        if self._master_fd is None:
            return b""
        try:
            return await asyncio.to_thread(os.read, self._master_fd, size)
        except OSError as error:
            if error.errno in {errno.EIO, errno.EBADF}:
                return b""
            raise

    async def write(self, value: str) -> None:
        if self._closed or not value:
            return
        if self._windows_process is not None:
            await asyncio.to_thread(self._windows_process.write, value)  # type: ignore[attr-defined]
            return
        if self._master_fd is not None:
            fd = self._master_fd
            data = memoryview(value.encode("utf-8"))

            def write_all() -> None:
                remaining = data
                while remaining:
                    written = os.write(fd, remaining)
                    remaining = remaining[written:]

            await asyncio.to_thread(write_all)

    async def resize(self, columns: int, rows: int) -> None:
        if self._closed:
            return
        self.columns = self._bounded_dimension(columns, self.columns, 20, 300)
        self.rows = self._bounded_dimension(rows, self.rows, 5, 120)
        if self._windows_process is not None:
            await asyncio.to_thread(self._windows_process.setwinsize, self.rows, self.columns)  # type: ignore[attr-defined]
            return
        if self._master_fd is not None:
            import fcntl
            import termios

            fcntl.ioctl(self._master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, self.columns, 0, 0))

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._windows_process is not None:
            process = self._windows_process
            try:
                if await asyncio.to_thread(process.isalive):  # type: ignore[attr-defined]
                    await asyncio.to_thread(process.terminate, force=True)  # type: ignore[attr-defined]
            except (OSError, RuntimeError, ValueError):
                pass
            self._windows_process = None

        process = self._process
        if process is not None and process.returncode is None:
            try:
                if self.tmux_session_name:
                    process.terminate()
                else:
                    os.killpg(process.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                with suppress(ProcessLookupError, PermissionError, OSError):
                    process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=1.5)
            except TimeoutError:
                try:
                    if self.tmux_session_name:
                        process.kill()
                    else:
                        os.killpg(process.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    with suppress(ProcessLookupError, PermissionError, OSError):
                        process.kill()
                await process.wait()
        self._process = None

        if self.tmux_session_name:
            with suppress(OSError, RuntimeError):
                await _set_tmux_last_used(self.tmux_session_name)

        if self._master_fd is not None:
            try:
                os.close(self._master_fd)
            except OSError:
                pass
            self._master_fd = None
