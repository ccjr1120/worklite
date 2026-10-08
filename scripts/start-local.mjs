#!/usr/bin/env node

import { spawn } from 'node:child_process';

const rootDir = new URL('..', import.meta.url);
const rootPath = decodeURIComponent(rootDir.pathname).replace(/\/$/, '');
const children = [];
let shuttingDown = false;
const webPort = process.env.WEB_PORT?.trim() || '23390';

const commands = [
  ['api', ['--filter', '@worklite/api', 'exec', 'nest', 'start', '--builder', 'webpack', '--webpackPath', 'webpack.config.js']],
  ['web', ['--filter', '@worklite/web', 'exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', webPort, ...(process.env.WORKLITE_WEB_DIST_DIR ? ['--outDir', process.env.WORKLITE_WEB_DIST_DIR] : [])]],
];

for (const [name, args] of commands) {
  const child = spawn('pnpm', args, {
    cwd: rootPath,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.once('exit', (code, signal) => {
    if (!shuttingDown) {
      process.stderr.write(`[${name}] exited (${code ?? 'no code'}${signal ? `, ${signal}` : ''})\n`);
      void shutdown('SIGTERM');
    }
  });
  children.push(child);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
