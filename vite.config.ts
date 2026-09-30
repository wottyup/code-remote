import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const engineProxy = {
  target: 'http://127.0.0.1:18766',
  changeOrigin: true,
  ws: true,
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    proxy: { '/api': engineProxy },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    proxy: { '/api': engineProxy },
  },
})
