/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En desarrollo Vite hace de gateway igual que nginx en el contenedor: el navegador solo
// llama a /api/... (mismo origen, sin CORS) y aquí se quita el prefijo /api hacia cada servicio.
const stripApi = (path: string) => path.replace(/^\/api/, '');

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api/auth': { target: 'http://localhost:3001', rewrite: stripApi }, // /api/auth/* → /auth/*
      '/api/transfers': { target: 'http://localhost:3002', rewrite: stripApi },
      '/api/accounts': { target: 'http://localhost:3002', rewrite: stripApi },
      '/api/payment-links': { target: 'http://localhost:3002', rewrite: stripApi },
      '/api/audit': { target: 'http://localhost:3003', rewrite: stripApi }, // /api/audit/* → /audit/*
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
  },
});
