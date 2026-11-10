import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Production runs without the TypeScript resolvers provided by Vite or Vitest.
for (const [app, args] of [
  ['api', ['-e', 'const m = require("@worklite/contracts"); if (typeof m.chatSuggestionContext !== "function") process.exit(1)']],
  ['portkey-gateway', ['--input-type=module', '-e', 'import { modelRequestParameters } from "@worklite/contracts"; if (typeof modelRequestParameters !== "function") process.exit(1)']],
]) {
  test(`contracts loads in the ${app} production Node runtime`, () => {
    const result = spawnSync(process.execPath, args, {
      cwd: fileURLToPath(new URL(`../apps/${app}/`, import.meta.url)),
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  });
}
