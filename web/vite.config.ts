import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: {
    outDir: '../internal/ui/dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/web': { target: 'http://127.0.0.1:8868', changeOrigin: true },
      '/api': { target: 'http://127.0.0.1:8868', changeOrigin: true },
      '/admin': { target: 'http://127.0.0.1:8868', changeOrigin: true },
      '/webauthn': { target: 'http://127.0.0.1:8868', changeOrigin: true },
      '/oauth': { target: 'http://127.0.0.1:8868', changeOrigin: true },
    },
  },
})
