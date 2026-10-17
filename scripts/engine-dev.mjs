import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverRoot = join(projectRoot, 'server')
const isWindows = process.platform === 'win32'
const configuredPython = process.env.CODEX_REMOTE_PYTHON
const virtualEnvironmentPython = isWindows ? join(projectRoot, '.venv', 'Scripts', 'python.exe') : join(projectRoot, '.venv', 'bin', 'python')
const python = configuredPython
  || (existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : null)
  || (isWindows ? 'python' : null)

if (!python) {
  console.error(`找不到 Python，请先创建 ${isWindows ? '.venv\\Scripts\\python.exe 或将 python.exe 加入 PATH' : '.venv/bin/python'}。也可以设置 CODEX_REMOTE_PYTHON。`)
  process.exit(1)
}

const engine = spawn(python, ['-m', 'codex_remote.main'], {
  cwd: serverRoot,
  env: process.env,
  stdio: 'inherit',
  windowsHide: false,
})

engine.once('error', (error) => {
  console.error(`无法启动 Python 后端：${error.message}`)
  process.exitCode = 1
})
engine.once('exit', (code, signal) => {
  if (signal) process.exitCode = 1
  else if (code !== null) process.exitCode = code
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => engine.kill(signal))
}
