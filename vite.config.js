import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Content-hashed file names allow immutable caching; the Node server serves them
// through a strict filename pattern instead of exposing the web/dist directory.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 4195,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:4173',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
