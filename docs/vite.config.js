import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

/**
 * The documentation site.
 *
 * Its own workspace rather than a route inside the app: the docs are read by people who have not
 * signed in — somebody evaluating this, or an operator on their phone during a job — and putting
 * them behind the app's auth gate would be the one place they are needed and unavailable. It is a
 * static build with no server of its own, so it can be dropped on any host.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    /* 5173 is the app and 4000 the API; the docs take the next free one along. */
    port: 5175,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
