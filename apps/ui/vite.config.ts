import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  envDir: '../..',
  // Production renderer origin is injected by the validated Local Server. Never
  // compile a machine-local VITE_PRODUCT_API_URL into the portable UI bundle.
  define: command === 'build'
    ? { 'import.meta.env.VITE_PRODUCT_API_URL': 'undefined' }
    : undefined,
  server: { strictPort: true },
  build: { outDir: 'dist', sourcemap: false },
}));
