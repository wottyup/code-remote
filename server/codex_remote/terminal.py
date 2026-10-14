from __future__ import annotations

import asyncio
import errno
import os
import shutil
import signal
import struct
from contextlib import suppress
from pathlib import Path


class TerminalSession:
    """One interactive shell attached to a browser terminal websocket."""

    def __init__(self, cwd: Path, columns: int, rows: int) -> None:
        self.cwd = cwd
        self.columns = self._bounded_dimension(columns, 100, 20, 300)
        self.rows = self._bounded_dimension(rows, 30, 5, 120)
        self.argv = self._shell_argv()
        self.shell_name = Path(self.argv[0]).name
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
    async def create(cls, cwd: Path, columns: int = 100, rows: int = 30) -> TerminalSession:
        session = cls(cwd, columns, rows)
        if os.name == "nt":
            await session._start_windows()
        else:
            await session._start_posix()
        return session

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
            self._process = await asyncio.create_subprocess_exec(
                *self.argv,
                cwd=str(self.cwd),
                env=self._environment(),
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                start_new_session=True,
            )
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
                if process.isalive():  # type: ignore[attr-defined]
                    await asyncio.to_thread(process.terminate, force=True)  # type: ignore[attr-defined]
            except (OSError, RuntimeError, ValueError):
                pass
            self._windows_process = None

        process = self._process
        if process is not None and process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                with suppress(ProcessLookupError, PermissionError, OSError):
                    process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=1.5)
            except TimeoutError:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    with suppress(ProcessLookupError, PermissionError, OSError):
                        process.kill()
                await process.wait()
        self._process = None

        if self._master_fd is not None:
            try:
                os.close(self._master_fd)
            except OSError:
                pass
            self._master_fd = None
