import { defineConfig } from 'vite';

export default defineConfig({
  root: 'frontend',
  build: {
    outDir: '../dist',
    emptyOutDir: true
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            console.warn('[vite-proxy] Proxy error:', err.message);
          });
        }
      },
      '/ws': {
        target: 'ws://localhost:4000',
        ws: true,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            console.warn('[vite-ws-proxy] WS error:', err.message);
          });
        }
      }
    }
  }
});
