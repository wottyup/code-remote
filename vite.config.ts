import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const engineProxy = {
  target: 'http://127.0.0.1:18766',
  changeOrigin: true,
  ws: true,
}

export default defineConfig({
  plugins: [react()],
  publicDir: 'punlic',
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
