import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  /**
   * Project-relative assets: the built site is served from
   * `https://<owner>.github.io/VoxelMinsk/`, not from the host root. HTML,
   * chunks, workers and every `publicAssetUrl(...)` payload must resolve below
   * the deployment directory. `import.meta.env.BASE_URL` therefore becomes
   * `'./'` at build time (see src/shared/assets.ts).
   */
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
});
