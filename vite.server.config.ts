import { defineConfig } from 'vite';
export default defineConfig({
  envDir: false,
  publicDir: false,
  build: {
    ssr: 'server/index.ts',
    outDir: 'build/server',
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: { output: { entryFileNames: 'index.js' } },
  },
});
