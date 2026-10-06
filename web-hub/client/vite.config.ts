import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:4020',
        ws: true
      },
      '/api': {
        target: 'http://localhost:4020'
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
