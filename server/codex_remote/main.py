from __future__ import annotations

import argparse
import os
from pathlib import Path

import uvicorn

from .app import create_app


def parse_arguments() -> argparse.Namespace:
    project_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="Run the local Codex Remote web engine")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address; defaults to loopback only")
    parser.add_argument("--port", type=int, default=18766)
    parser.add_argument("--workspace", type=Path, default=Path(os.environ.get("CODEX_REMOTE_WORKSPACE", project_root.parent)))
    parser.add_argument("--codex-command", default=os.environ.get("CODEX_REMOTE_COMMAND", "codex"))
    return parser.parse_args()


def main() -> None:
    arguments = parse_arguments()
    app = create_app(arguments.workspace, arguments.codex_command)
    uvicorn.run(app, host=arguments.host, port=arguments.port, log_level="info")


if __name__ == "__main__":
    main()
