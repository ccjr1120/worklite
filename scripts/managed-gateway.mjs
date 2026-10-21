#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const root = process.env.WORKLITE_RELEASE_ROOT;
const port = Number(process.env.PORTKEY_GATEWAY_PORT);
if (!root || !Number.isInteger(port) || port < 1) throw new Error('A managed release root and Gateway port are required.');

const gatewayDirectory = join(root, 'apps/portkey-gateway');
const entry = join(gatewayDirectory, 'build/start-server.js');
const preload = join(root, 'apps/api/portkey-local-bind.cjs');
const dataDirectory = process.env.WORKLITE_DATA_DIRECTORY;
if (!dataDirectory) throw new Error('A managed data directory is required.');

let stopping = false;
let child;
let stopTimer;

async function run() {
  let failures = 0;
  while (!stopping) {
    await new Promise((resolve) => {
      child = spawn(process.execPath, ['-r', preload, entry, `--port=${port}`, '--headless'], {
        cwd: gatewayDirectory,
        env: {
          ...process.env,
          PORT: String(port),
          PORTKEY_GATEWAY_DB_PATH: join(dataDirectory, 'worklite-gateway.db'),
          WORKLITE_GATEWAY_PID: String(process.pid),
        },
        stdio: 'inherit',
      });
      child.once('error', (error) => {
        process.stderr.write(`Gateway launch failed: ${error.message}\n`);
        resolve();
      });
      child.once('exit', (code, signal) => {
        if (!stopping) process.stderr.write(`Gateway exited (${code ?? 'no code'}${signal ? `, ${signal}` : ''}); restarting.\n`);
        resolve();
      });
    });
    child = undefined;
    if (stopping) break;
    const delay = Math.min(500 * (2 ** Math.min(failures, 5)), 15_000);
    failures += 1;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function stop() {
  if (stopping) return;
  stopping = true;
  child?.kill('SIGTERM');
  stopTimer = setTimeout(() => child?.kill('SIGKILL'), 15_000);
  stopTimer.unref();
}

process.once('SIGTERM', stop);
process.once('SIGINT', stop);
await run();
if (stopTimer) clearTimeout(stopTimer);
