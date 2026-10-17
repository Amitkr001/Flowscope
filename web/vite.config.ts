import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.FLOWSCOPE_API || 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': API,
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
