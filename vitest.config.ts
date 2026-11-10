import { configDefaults, defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'apps/web/src'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'workspace',
          environment: 'jsdom',
          include: ['apps/**/*.test.{ts,tsx}', 'packages/**/*.test.{ts,tsx}'],
          exclude: [...configDefaults.exclude, 'apps/portkey-gateway/**'],
          setupFiles: ['apps/web/test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'gateway',
          env: { CODEX_OAUTH_CALLBACK_ENABLED: 'false' },
          environment: 'node',
          globals: true,
          // WorkLite Gateway regressions and upstream pure utility tests run locally. Vendor
          // plugin/live-provider suites keep their own Jest runner and credential requirements.
          include: ['apps/portkey-gateway/src/worklite/**/*.test.ts', 'apps/portkey-gateway/src/providers/**/*.test.ts'],
        },
      },
    ],
  },
});
