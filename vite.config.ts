import { defineConfig } from 'vite';
export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: { outDir: '../../dist/renderer', emptyOutDir: true, target: 'es2023' },
  server: { host: '127.0.0.1' },
});
