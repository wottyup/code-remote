import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const engineProxy = {
  target: 'http://127.0.0.1:18766',
  changeOrigin: true,
  ws: true,
}

export default defineConfig({
  plugins: [react(), {
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
        '**/.codex-remote/**',
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
