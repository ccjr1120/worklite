#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const releaseRoot = process.env.WORKLITE_RELEASE_ROOT;
if (!releaseRoot) throw new Error('A managed release root is required.');
const children = [];
let stopping = false;
const environment = { ...process.env, WORKLITE_RUNTIME_PID: String(process.pid) };
const commands = [
  [process.execPath, [join(releaseRoot, 'apps/api/dist/main.js')], join(releaseRoot, 'apps/api')],
  ['pnpm', ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--strictPort', '--port', environment.WEB_PORT], join(releaseRoot, 'apps/web')],
];
environment.WORKLITE_MANAGED_GATEWAY = '1';
for (const [executable, args, cwd] of commands) {
  const child = spawn(executable, args, { cwd, env: environment, stdio: 'inherit' });
  children.push(child);
  child.once('error', () => void stop(1));
  child.once('exit', () => { if (!stopping) void stop(1); });
}
async function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  const deadline = Date.now() + 15_000;
  while (children.some((child) => child.exitCode === null && child.signalCode === null) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  process.exit(code);
}
process.once('SIGTERM', () => void stop(0));
process.once('SIGINT', () => void stop(0));
