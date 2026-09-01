import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    {
      name: 'disrunner-development-style-csp',
      apply: 'serve',
      transformIndexHtml(html) {
        return html.replace("style-src 'self';", "style-src 'self' 'unsafe-inline';");
      },
    },
    react(),
  ],
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
