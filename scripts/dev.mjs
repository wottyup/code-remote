import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverRoot = join(projectRoot, 'server')
const isWindows = process.platform === 'win32'
const configuredPython = process.env.CODEX_REMOTE_PYTHON
const virtualEnvironmentPython = isWindows ? join(projectRoot, '.venv', 'Scripts', 'python.exe') : join(projectRoot, '.venv', 'bin', 'python')
const python = configuredPython || (existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : null)
const packageManager = isWindows ? 'pnpm.cmd' : 'pnpm'

let engine = null
let vite = null
let ownsEngine = false
let shuttingDown = false

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function engineReady() {
  try {
    const response = await fetch('http://127.0.0.1:18766/health')
    return response.ok
  } catch {
    return false
  }
}

function stopProcess(child) {
  if (!child || child.exitCode !== null) return Promise.resolve()
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolvePromise()
    }
    child.once('exit', finish)
    child.kill('SIGTERM')
    setTimeout(() => {
      if (settled) return
      if (isWindows && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
        killer.once('exit', finish)
        killer.once('error', finish)
      } else {
        child.kill('SIGKILL')
        finish()
      }
    }, 3_000).unref()
  })
}

async function waitForEngine() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await engineReady()) return
    if (engine?.exitCode !== null) {
      throw new Error('Codex Remote 后端启动失败，请检查上面的 Python/Codex 错误。')
    }
    await sleep(100)
  }
  throw new Error('本机 Codex 引擎未能在 10 秒内就绪。')
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  await stopProcess(vite)
  if (ownsEngine) await stopProcess(engine)
  process.exitCode = exitCode
}

async function main() {
  if (!python) {
    throw new Error(`找不到 Python 虚拟环境，请先创建 ${isWindows ? '.venv\\Scripts\\python.exe' : '.venv/bin/python'}。也可以设置 CODEX_REMOTE_PYTHON 指向 Python。`)
  }

  if (await engineReady()) {
    console.log('复用已运行的本机 Codex 引擎。')
  } else {
    ownsEngine = true
    engine = spawn(python, ['-m', 'codex_remote.main'], {
      cwd: serverRoot,
      env: process.env,
      stdio: 'inherit',
      windowsHide: false,
    })
    engine.once('error', (error) => {
      console.error(`无法启动 Python 后端：${error.message}`)
      void shutdown(1)
    })
    engine.once('exit', (code, signal) => {
      if (!shuttingDown) {
        console.error(`Python 后端已退出（${signal ?? code ?? '未知原因'}）。`)
        void shutdown(code && code > 0 ? code : 1)
      }
    })
    await waitForEngine()
  }

  vite = spawn(packageManager, ['exec', 'vite'], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  })
  vite.once('error', (error) => {
    console.error(`无法启动 Vite：${error.message}`)
    void shutdown(1)
  })
  vite.once('exit', (code, signal) => {
    if (!shuttingDown) void shutdown(code ?? (signal ? 1 : 0))
  })
}

process.on('SIGINT', () => void shutdown(130))
process.on('SIGTERM', () => void shutdown(143))

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error)
  await shutdown(1)
})
