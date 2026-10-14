import { defineConfig } from 'vite';
export default defineConfig({
  root: 'web',
  publicDir: 'public',
  server: { port: 5173 },
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
});
