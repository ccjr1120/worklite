#!/usr/bin/env node

import { openSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const [logPath, pidPath] = process.argv.slice(2);
if (!logPath || !pidPath) {
  console.error('Usage: node scripts/start-background.mjs <log-path> <pid-path>');
  process.exit(2);
}

const log = openSync(logPath, 'a');
const child = spawn(process.execPath, ['scripts/start-local.mjs'], {
  cwd: process.cwd(),
  detached: true,
  stdio: ['ignore', log, log],
  env: process.env,
});
child.unref();
writeFileSync(pidPath, `${child.pid}\n`, 'utf8');
process.stdout.write(`${child.pid}\n`);
