#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [command, ...args] = process.argv.slice(2);
if (!command || command === '--help' || command === '-h') {
  console.log('Usage: worklite <start|restart>\n\n  start    Start the deployed version, or leave it running\n  restart  Restart the deployed version');
} else if (!['start', 'restart'].includes(command) || args.length) {
  console.error('Usage: worklite <start|restart>');
  process.exitCode = 1;
} else {
  const runner = join(dirname(fileURLToPath(import.meta.url)), 'upgrade-runner.mjs');
  const result = spawnSync(process.execPath, [runner, command], { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
