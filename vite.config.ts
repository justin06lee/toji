import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'apps/renderer',
  // Relative asset URLs so the renderer loads correctly under file:// in the packaged app.
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true
  }
});
