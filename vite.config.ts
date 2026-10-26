import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { normalizeBasePath } from './shared/base-path';
const basePath = normalizeBasePath(process.env.MIRA_BASE_PATH);
export default defineConfig({
  base: basePath + '/',
  envDir: false,
  plugins: [
    react(),
    {
      name: 'mira-build-path',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'mira-build.json',
          source: JSON.stringify({ basePath }),
        });
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { [basePath + '/api']: { target: 'http://127.0.0.1:3001', ws: true } },
  },
  build: { outDir: 'dist' },
});
