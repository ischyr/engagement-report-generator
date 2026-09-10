import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    port: 5173,
    strictPort: true,
    // The client calls /api/* relatively, so cookies stay first-party in dev.
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        /*
         * Collaborative editing upgrades `/api/collab` to a WebSocket, and a proxy that does not
         * pass upgrades turns that into the single-writer editor — silently, because that is
         * exactly what the feature is built to degrade into. Which makes this one line the
         * difference between "it does not work in dev" and "it works and nobody can say why".
         */
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
