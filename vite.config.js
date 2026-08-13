import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Honor an assigned port (preview harness / busy-port fallback); 5173 default.
    port: Number(process.env.PORT) || 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
