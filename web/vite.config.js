import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// BASE_PATH is set by the GitHub Pages workflow ("/<repo>/"); locally the site lives at "/".
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  build: {
    rollupOptions: {
      input: { main: resolve(import.meta.dirname, 'index.html'), abudhabi: resolve(import.meta.dirname, 'abudhabi.html') },
    },
  },
});
