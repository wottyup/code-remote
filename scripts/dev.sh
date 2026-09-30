#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
python_bin="$project_root/.venv/bin/python"
engine_pid=""

engine_ready() {
  curl --silent --fail --max-time 1 http://127.0.0.1:18766/health >/dev/null 2>&1
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ -n "$engine_pid" ]] && kill -0 "$engine_pid" 2>/dev/null; then
    printf '\n正在停止本机 Codex 引擎…\n'
    kill -TERM "$engine_pid"
    wait "$engine_pid" || true
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if engine_ready; then
  printf '复用已运行的本机 Codex 引擎。\n'
else
  if [[ ! -x "$python_bin" ]]; then
    printf '找不到 Python 虚拟环境：%s\n请先按 README 创建 .venv 并安装 server/requirements.txt。\n' "$python_bin" >&2
    exit 1
  fi

  (
    cd "$project_root/server"
    exec "$python_bin" -m codex_remote.main
  ) &
  engine_pid=$!

  for _ in $(seq 1 100); do
    if engine_ready; then
      break
    fi
    if ! kill -0 "$engine_pid" 2>/dev/null; then
      wait "$engine_pid"
      exit 1
    fi
    sleep 0.1
  done

  if ! engine_ready; then
    printf '本机 Codex 引擎未能在 10 秒内就绪。\n' >&2
    exit 1
  fi
fi

cd "$project_root"
exec_status=0
pnpm exec vite || exec_status=$?
exit "$exec_status"
