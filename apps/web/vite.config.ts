import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const packageVersion = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string;

function buildTag(): string {
  const now = new Date();
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  define: {
    __WORKLITE_VERSION__: JSON.stringify(packageVersion),
    __WORKLITE_BUILD_TAG__: JSON.stringify(buildTag()),
  },
  resolve: {
    alias: {
      '@': path.resolve(rootDir, './src'),
    },
  },
  server: {
    port: 3390,
    proxy: {
      '/api': {
        target: 'http://localhost:3391',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 23390,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:23391',
        changeOrigin: true,
      },
    },
  },
});
