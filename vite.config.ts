import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, promises as fs } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'

const androidPackageName = /^devwisp-android-(\d+)\.(\d+)\.(\d+)(?:-(dev|beta)\.(\d+))?-debug\.apk$/

function androidVersionRank(name: string): number[] | null {
  const match = androidPackageName.exec(name)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3]),
    match[4] === 'dev' ? 0 : match[4] === 'beta' ? 1 : 2, Number(match[5] ?? 0)]
}

function compareAndroidRanks(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function updateJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(data))
}

async function handleAndroidUpdate(request: IncomingMessage, response: ServerResponse, artifacts: string, filename?: string): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    updateJson(response, 405, { detail: '只支持 GET 或 HEAD' })
    return
  }
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Bearer ')) {
    updateJson(response, 401, { detail: '需要配对码' })
    return
  }
  const authResult = await fetch('http://127.0.0.1:18766/api/v1/codex/status', {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(5000),
  })
  if (!authResult.ok) {
    updateJson(response, authResult.status === 401 ? 401 : 502, { detail: '电脑服务不可用或配对已失效' })
    return
  }
  if (filename !== undefined) {
    const rank = androidVersionRank(filename)
    if (!rank) {
      updateJson(response, 404, { detail: '安装包不存在' })
      return
    }
    const path = resolve(artifacts, filename)
    const info = await fs.lstat(path).catch(() => null)
    if (!info?.isFile() || info.size === 0) {
      updateJson(response, 404, { detail: '安装包不存在' })
      return
    }
    let start = 0
    let end = info.size - 1
    const rangeHeader = request.headers.range
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
      if (!match || (!match[1] && !match[2])) {
        response.writeHead(416, { 'Content-Range': `bytes */${info.size}` })
        response.end()
        return
      }
      if (match[1]) {
        start = Number(match[1])
        if (match[2]) end = Number(match[2])
      } else {
        const suffixLength = Number(match[2])
        start = Math.max(0, info.size - suffixLength)
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= info.size || start > end) {
        response.writeHead(416, { 'Content-Range': `bytes */${info.size}` })
        response.end()
        return
      }
      end = Math.min(end, info.size - 1)
    }
    response.writeHead(rangeHeader ? 206 : 200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      ...(rangeHeader ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    createReadStream(path, { start, end }).on('error', (error) => response.destroy(error)).pipe(response)
    return
  }
  const entries = await fs.readdir(artifacts, { withFileTypes: true }).catch(() => [])
  const packages = entries.flatMap((entry) => {
    const rank = entry.isFile() ? androidVersionRank(entry.name) : null
    return rank ? [{ name: entry.name, rank }] : []
  }).sort((left, right) => compareAndroidRanks(right.rank, left.rank))
  for (const candidate of packages) {
    const path = resolve(artifacts, candidate.name)
    const info = await fs.lstat(path).catch(() => null)
    if (!info?.isFile() || info.size === 0) continue
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(path)) digest.update(chunk)
    updateJson(response, 200, {
      version: candidate.name.slice('devwisp-android-'.length, -'-debug.apk'.length),
      filename: candidate.name,
      sizeBytes: info.size,
      sha256: digest.digest('hex'),
    })
    return
  }
  updateJson(response, 404, { detail: '本机尚无 Android 安装包' })
}

function androidUpdateMiddleware(artifacts: string) {
  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const match = /^\/api\/v1\/android\/update(?:\/([^/?]+))?(?:\?.*)?$/.exec(request.url ?? '')
    if (!match) return next()
    let filename: string | undefined
    try {
      filename = match[1] ? decodeURIComponent(match[1]) : undefined
    } catch {
      updateJson(response, 400, { detail: '安装包文件名无效' })
      return
    }
    void handleAndroidUpdate(request, response, artifacts, filename).catch(() => {
      if (!response.headersSent) updateJson(response, 502, { detail: '检查更新失败' })
      else response.destroy()
    })
  }
}

const engineProxy = {
  target: 'http://127.0.0.1:18766',
  changeOrigin: true,
  ws: true,
}

export default defineConfig({
  plugins: [react(), {
    name: 'local-android-updates',
    configureServer(server) {
      server.middlewares.use(androidUpdateMiddleware(resolve(server.config.root, 'artifacts')))
    },
    configurePreviewServer(server) {
      server.middlewares.use(androidUpdateMiddleware(resolve(server.config.root, 'artifacts')))
    },
  }, {
    name: 'remote-preview-cache',
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0] ?? ''
        if (/^\/assets\/[\w.-]+-[\w-]+\.[\w]+$/.test(path)
          && existsSync(resolve(server.config.root, server.config.build.outDir, path.slice(1)))) {
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        }
        next()
      })
    },
  }],
  publicDir: 'public',
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
  server: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    watch: {
      // These are not served by Vite. Android builds in particular create
      // enough directories to exhaust the host's inotify watcher limit.
      ignored: [
        '**/android/**',
        '**/artifacts/**',
        '**/.devwisp/**',
        '**/docs/**',
        '**/dist/**',
        '**/server/**',
        '**/.venv/**',
        '**/tests/**',
      ],
    },
    proxy: { '/api': engineProxy },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    proxy: { '/api': engineProxy },
  },
})
