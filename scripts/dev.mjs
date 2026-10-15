import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Existing installed services invoke this file without flags. Keep their
// next restart on the compact build too; hot reload is explicitly opt-in.
const production = !process.argv.includes('--development')
const serverRoot = join(projectRoot, 'server')
const viteEntrypoint = join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const isWindows = process.platform === 'win32'
const configuredPython = process.env.CODEX_REMOTE_PYTHON
const configuredCodex = process.env.CODEX_REMOTE_COMMAND
const managedDaemonCodex = isWindows
  ? join(process.env.USERPROFILE || '', '.codex', 'packages', 'app-server-daemon', 'current', 'bin', 'codex.exe')
  : ''
const pathDirectories = (process.env.PATH || '').split(isWindows ? ';' : ':').filter(Boolean)
const pathCodexCandidates = pathDirectories.flatMap((directory) =>
  isWindows
    ? [join(directory, 'codex.cmd'), join(directory, 'codex.exe')]
    : [join(directory, 'codex')],
)
const vscodeExtensionRoot = isWindows ? join(process.env.USERPROFILE || '', '.vscode', 'extensions') : ''
const vscodeCodexCandidates = isWindows && existsSync(vscodeExtensionRoot)
  ? readdirSync(vscodeExtensionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
      .sort((left, right) => right.name.localeCompare(left.name))
      .map((entry) => join(vscodeExtensionRoot, entry.name, 'bin', 'windows-x86_64', 'codex.exe'))
  : []
const windowsCodexCandidates = isWindows
  ? [
      ...pathCodexCandidates,
      managedDaemonCodex,
      join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'codex.exe'),
      join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
      ...vscodeCodexCandidates,
      join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin', '8aaf1547b825b104', 'codex.exe'),
    ]
  : []
const virtualEnvironmentPython = isWindows
  ? join(projectRoot, '.venv', 'Scripts', 'python.exe')
  : join(projectRoot, '.venv', 'bin', 'python')
const python = configuredPython || (existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : null)

let engine = null
let vite = null
let ownsEngine = false
let shuttingDown = false
let viteRestartTimer = null
let viteStableTimer = null
let viteRestartAttempts = 0

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function cleanCodexEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CODEX_') && !['CODEX_HOME', 'CODEX_REMOTE_APP_SERVER_HOME', 'CODEX_REMOTE_COMMAND', 'CODEX_REMOTE_PYTHON', 'CODEX_REMOTE_WORKSPACE', 'CODEX_REMOTE_AUTH_FILE'].includes(key)) {
      delete process.env[key]
    }
  }
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
  if (viteRestartTimer) clearTimeout(viteRestartTimer)
  if (viteStableTimer) clearTimeout(viteStableTimer)
  viteRestartTimer = null
  viteStableTimer = null
  await stopProcess(vite)
  if (ownsEngine) await stopProcess(engine)
  process.exitCode = exitCode
}

function scheduleViteRestart(reason) {
  if (shuttingDown || viteRestartTimer) return
  const delay = Math.min(10_000, 1_000 * (2 ** Math.min(viteRestartAttempts, 4)))
  viteRestartAttempts += 1
  console.error(`${reason} 将在 ${Math.ceil(delay / 1000)} 秒后重启；Codex 后端继续运行。`)
  viteRestartTimer = setTimeout(() => {
    viteRestartTimer = null
    startVite()
  }, delay)
}

function startVite() {
  if (shuttingDown) return

  const child = spawn(process.execPath, [viteEntrypoint, ...(production ? ['preview'] : [])], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  })
  vite = child

  child.once('spawn', () => {
    if (shuttingDown || vite !== child) return
    if (viteStableTimer) clearTimeout(viteStableTimer)
    viteStableTimer = setTimeout(() => {
      if (vite === child) viteRestartAttempts = 0
      viteStableTimer = null
    }, 30_000)
  })
  child.once('error', (error) => {
    if (vite === child) vite = null
    scheduleViteRestart(`无法启动 Vite：${error.message}`)
  })
  child.once('exit', (code, signal) => {
    if (vite === child) vite = null
    if (viteStableTimer) clearTimeout(viteStableTimer)
    viteStableTimer = null
    if (!shuttingDown) {
      scheduleViteRestart(`Vite 网页服务已退出（${signal ?? code ?? '未知原因'}）`)
    }
  })
}

async function main() {
  if (!python) {
    throw new Error(`找不到 Python 虚拟环境，请先创建 ${isWindows ? '.venv\\Scripts\\python.exe' : '.venv/bin/python'}。也可以设置 CODEX_REMOTE_PYTHON 指向 Python。`)
  }
  if (!existsSync(viteEntrypoint)) {
    throw new Error(`找不到 Vite 启动文件：${viteEntrypoint}。请先在 workspace 根目录完成依赖安装。`)
  }
  if (production && !existsSync(join(projectRoot, 'dist', 'index.html'))) {
    throw new Error('没有找到网页构建产物，请先执行 pnpm build，或使用 pnpm start 自动构建后启动。')
  }

  if (!configuredCodex && windowsCodexCandidates.some((candidate) => existsSync(candidate))) {
    process.env.CODEX_REMOTE_COMMAND = windowsCodexCandidates.find((candidate) => existsSync(candidate))
  }
  cleanCodexEnvironment()

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

  startVite()
}

process.on('SIGINT', () => void shutdown(130))
process.on('SIGTERM', () => void shutdown(143))

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error)
  await shutdown(1)
})
