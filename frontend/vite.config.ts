import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server: same-origin /api calls are proxied to FastAPI on port 8000,
// so the session cookie works without CORS complexity.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
