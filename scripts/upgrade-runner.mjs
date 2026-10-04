#!/usr/bin/env node
// Runs only after an operator installation command or a release-bound Feishu confirmation.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, lstatSync, readlinkSync, symlinkSync, chmodSync, rmSync, openSync, closeSync } from 'node:fs';

const [command, ...args] = process.argv.slice(2);
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
function write(path, value) { mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, path); }
function alive(pid) { try { process.kill(pid, 0); return Number.isInteger(pid) && pid > 1; } catch { return false; } }

function prepare(projectRoot, state, id) {
  projectRoot = resolve(projectRoot);
  const root = join(state, 'releases', id);
  mkdirSync(root, { recursive: true });
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: projectRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
  const manifest = [];
  for (const path of [...new Set(paths)].sort()) {
    if (path === '.data' || path.startsWith('.data/') || path.split('/').includes('node_modules') || !existsSync(join(projectRoot, path))) continue;
    const source = join(projectRoot, path); const destination = join(root, path); const info = lstatSync(source);
    if (!info.isFile() && !info.isSymbolicLink()) continue;
    if (info.isSymbolicLink()) {
      const target = relative(projectRoot, resolve(dirname(source), readlinkSync(source)));
      if (target.startsWith('../') || target === '..' || !paths.includes(target)) throw new Error('Release links must refer to another captured project file.');
    }
    mkdirSync(dirname(destination), { recursive: true });
    if (info.isSymbolicLink()) symlinkSync(readlinkSync(source), destination);
    else { cpSync(source, destination); chmodSync(destination, info.mode); }
    manifest.push({ path, mode: info.mode, symlink: info.isSymbolicLink(), hash: createHash('sha256').update(info.isSymbolicLink() ? readlinkSync(destination) : readFileSync(destination)).digest('hex') });
  }
  const releaseHash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  write(join(root, 'release-manifest.json'), { releaseHash, files: manifest });
  return { releaseHash, releaseDirectory: root };
}

function assertRelease(release) {
  const manifest = read(join(release.releaseDirectory, 'release-manifest.json'));
  if (manifest.releaseHash !== release.releaseHash || createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex') !== release.releaseHash) throw new Error('Release manifest changed.');
  for (const file of manifest.files) {
    const path = join(release.releaseDirectory, file.path);
    const hash = createHash('sha256').update(file.symlink ? readlinkSync(path) : readFileSync(path)).digest('hex');
    if (hash !== file.hash || lstatSync(path).mode !== file.mode) throw new Error('Release source changed after confirmation.');
  }
}

async function build(root, log) {
  for (const argv of [
    ['install', '--frozen-lockfile'],
    ['--filter', '@portkey-ai/gateway', 'build'],
    ['--filter', '@worklite/api', 'exec', 'nest', 'build', '--builder', 'webpack', '--webpackPath', 'webpack.config.js'],
    ['--filter', '@worklite/web', 'exec', 'vite', 'build'],
  ]) await new Promise((done, fail) => {
    const child = spawn('pnpm', argv, { cwd: root, env: process.env, stdio: ['ignore', log, log] });
    child.once('error', fail); child.once('exit', (code) => code === 0 ? done() : fail(new Error('Candidate compilation failed; see the upgrade log.')));
  });
}

async function portsFree(ports) {
  for (const port of ports) await new Promise((done, fail) => {
    const server = createServer(); server.once('error', () => fail(new Error(`Port ${port} is occupied; its listener will not be stopped.`)));
    server.listen(port, '127.0.0.1', () => server.close(done));
  });
}

function profileEnvironment(runtime, data, ports, preflight) {
  return { ...process.env, API_HOST: '127.0.0.1', WEB_PORT: String(ports[0]), API_PORT: String(ports[1]), PORTKEY_GATEWAY_PORT: String(ports[2]),
    SQLITE_PATH: join(data, 'worklite.db'), PORTKEY_GATEWAY_DB_PATH: join(data, 'worklite-gateway.db'), AGENT_TEAM_CHECKPOINT_PATH: join(data, 'agent-teams/checkpoints.sqlite'),
    WORKLITE_RELEASE_ROOT: runtime.releaseDirectory, WORKLITE_RELEASE_HASH: runtime.releaseHash, WORKLITE_PROJECT_ROOT: runtime.projectRoot,
    WORKLITE_RUNTIME_STATE_DIR: preflight ? '' : runtime.stateDirectory, WORKLITE_PREFLIGHT: preflight ? '1' : '0' };
}

function launch(runtime, data, ports, preflight, log) {
  const child = spawn(process.execPath, [join(runtime.releaseDirectory, 'scripts/managed-runtime.mjs')], { cwd: runtime.releaseDirectory, env: profileEnvironment(runtime, data, ports, preflight), detached: true, stdio: ['ignore', log, log] });
  child.unref(); return child.pid;
}

async function ready(pid, ports, hash) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!alive(pid)) throw new Error('The managed runtime exited before readiness.');
    try {
      const responses = await Promise.all([fetch(`http://127.0.0.1:${ports[0]}/`, { signal: AbortSignal.timeout(1000) }), fetch(`http://127.0.0.1:${ports[1]}/api/upgrades/runtime`, { signal: AbortSignal.timeout(1000) }), fetch(`http://127.0.0.1:${ports[2]}/`, { signal: AbortSignal.timeout(1000) })]);
      if (responses.every((response) => response.ok)) {
        const runtime = await responses[1].json();
        if (runtime.releaseHash === hash && runtime.wrapperPid === pid) {
          const listenersOwned = ports.every((port) => {
            const listeners = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
            return listeners.length > 0 && listeners.every((listener) => Number(execFileSync('ps', ['-p', listener, '-o', 'pgid='], { encoding: 'utf8' }).trim()) === pid);
          });
          if (listenersOwned) return;
        }
      }
    } catch { /* The candidate is still starting. */ }
    await sleep(250);
  }
  throw new Error('Runtime readiness timed out.');
}

async function stop(pid, releaseDirectory) {
  if (!alive(pid)) return;
  const processCommand = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (!processCommand.includes(join(releaseDirectory, 'scripts/managed-runtime.mjs'))) throw new Error('The recorded PID is not the owned managed runtime; refusing to stop it.');
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 20_000;
  while (alive(pid) && Date.now() < deadline) await sleep(100);
  // Only the process group created by this runner is eligible for termination.
  try { process.kill(-pid, 'SIGKILL'); } catch { /* All owned processes already exited. */ }
}

async function copyData(source, destination, moduleRoot) {
  mkdirSync(destination, { recursive: true });
  const SQLite = createRequire(join(moduleRoot, 'apps/api/package.json'))('better-sqlite3');
  async function copy(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const from = join(directory, entry.name); const subpath = relative(source, from); const to = join(destination, subpath);
      if (subpath === 'runtime' || subpath.startsWith('runtime/') || subpath === 'deployment' || /-(wal|shm)$/.test(entry.name)) continue;
      if (entry.isDirectory()) { mkdirSync(to, { recursive: true }); await copy(from); }
      else if (entry.isFile()) {
        mkdirSync(dirname(to), { recursive: true });
        const header = Buffer.alloc(16); const fd = openSync(from, 'r');
        const { readSync } = await import('node:fs'); readSync(fd, header, 0, 16, 0); closeSync(fd);
        if (header.toString() === 'SQLite format 3\0') { const database = new SQLite(from, { readonly: true }); try { await database.backup(to); } finally { database.close(); } }
        else cpSync(from, to);
      }
    }
  }
  await copy(source);
}

function restoreData(backup, data) {
  for (const entry of readdirSync(data)) if (entry !== 'runtime' && entry !== 'deployment') rmSync(join(data, entry), { recursive: true, force: true });
  cpSync(backup, data, { recursive: true });
}

async function preflight(runtime, release, log, id) {
  const data = join(runtime.stateDirectory, 'preflight', id);
  await portsFree(runtime.preflightPorts);
  await copyData(runtime.dataDirectory, data, runtime.releaseDirectory);
  const candidate = { ...runtime, ...release };
  let pid;
  try { pid = launch(candidate, data, runtime.preflightPorts, true, log); await ready(pid, runtime.preflightPorts, candidate.releaseHash); }
  finally { if (pid) await stop(pid, candidate.releaseDirectory); rmSync(data, { recursive: true, force: true }); }
}

async function install(profile) {
  if (!['development', 'deployment'].includes(profile)) throw new Error('Select development or deployment explicitly.');
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dataDirectory = join(projectRoot, '.data', ...(profile === 'deployment' ? ['deployment'] : []));
  const stateDirectory = join(dataDirectory, 'runtime');
  const currentPath = join(stateDirectory, 'current.json');
  if (existsSync(currentPath)) throw new Error('A managed baseline already exists; use a confirmed upgrade request.');
  const id = `baseline_${randomUUID()}`;
  const release = prepare(projectRoot, stateDirectory, id);
  const runtime = { ...release, projectRoot, dataDirectory, stateDirectory, ports: profile === 'deployment' ? [23390, 23391, 23392] : [3390, 3391, 3392], preflightPorts: profile === 'deployment' ? [23490, 23491, 23492] : [3490, 3491, 3492] };
  const log = openSync(join(stateDirectory, 'install.log'), 'a', 0o600);
  try {
    await build(release.releaseDirectory, log);
    await preflight(runtime, release, log, id);
    await portsFree(runtime.ports);
    const backup = join(stateDirectory, 'backups', id);
    await copyData(dataDirectory, backup, release.releaseDirectory);
    write(currentPath, runtime);
    runtime.pid = launch(runtime, dataDirectory, runtime.ports, false, log); write(currentPath, runtime);
    try { await ready(runtime.pid, runtime.ports, runtime.releaseHash); }
    catch (error) { await stop(runtime.pid, runtime.releaseDirectory); restoreData(backup, dataDirectory); rmSync(currentPath); throw error; }
    process.stdout.write(`Managed WorkLite baseline started on port ${runtime.ports[0]}.\n`);
  } finally { closeSync(log); }
}

async function run(state, id) {
  const jobPath = join(state, 'upgrades', `${id}.json`);
  let job = read(jobPath);
  if (!job.confirmedAt || job.releaseHash === undefined) throw new Error('User confirmation is required.');
  const lockPath = join(state, 'upgrade-runner.lock');
  if (existsSync(lockPath)) { const lock = read(lockPath); if (alive(lock.pid)) return; rmSync(lockPath); }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  const log = openSync(join(state, 'upgrades', `${id}.log`), 'a', 0o600);
  const currentPath = join(state, 'current.json');
  const current = read(currentPath);
  const previous = job.previous ?? current;
  const backup = join(state, 'backups', id);
  const phase = (value, extra = {}) => { job = { ...read(jobPath), ...extra, phase: value, runnerPid: process.pid, updatedAt: new Date().toISOString() }; write(jobPath, job); };
  async function call(action) {
    const response = await fetch(`http://127.0.0.1:${previous.ports[1]}/api/upgrades/${id}/${action}`, { method: 'POST', headers: { 'x-worklite-upgrade-token': job.token }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Upgrade ${action} did not complete.`);
    return response.json();
  }
  async function recover() {
    phase('recovering');
    const running = read(currentPath);
    if (running.pid) await stop(running.pid, running.releaseDirectory);
    if (job.backupComplete) restoreData(backup, previous.dataDirectory);
    await portsFree(previous.ports);
    previous.pid = launch(previous, previous.dataDirectory, previous.ports, false, log); write(currentPath, previous);
    await ready(previous.pid, previous.ports, previous.releaseHash);
    phase('rolled_back', { resumePending: true, error: '新版本未完成切换，已恢复对应的旧版本和数据。详情见本机升级日志。' });
    try { await call('resume'); } catch { /* The API retries the persisted handoff. */ }
  }
  try {
    if (['frozen', 'switching', 'recovering'].includes(job.phase)) { await recover(); return; }
    phase('preflighting', { previous });
    assertRelease(job);
    await build(job.releaseDirectory, log);
    await preflight(previous, job, log, id);
    // No target process may be stopped before the isolated candidate is ready.
    const ownership = await fetch(`http://127.0.0.1:${previous.ports[1]}/api/upgrades/runtime`, { signal: AbortSignal.timeout(3000) }).then((response) => response.json());
    if (ownership.releaseHash !== previous.releaseHash || ownership.wrapperPid !== previous.pid) throw new Error('Target listeners are not owned by the recorded managed runtime.');
    phase('draining');
    const deadline = Date.now() + 15 * 60_000;
    while (!(await call('handoff')).ready) { if (Date.now() > deadline) throw new Error('Task handoff timed out; no service was replaced.'); await sleep(1000); }
    await call('freeze'); job = read(jobPath);
    await stop(previous.pid, previous.releaseDirectory);
    await portsFree(previous.ports);
    await copyData(previous.dataDirectory, backup, previous.releaseDirectory);
    phase('switching', { backupComplete: true });
    const candidate = { ...previous, releaseHash: job.releaseHash, releaseDirectory: job.releaseDirectory };
    candidate.pid = launch(candidate, candidate.dataDirectory, candidate.ports, false, log); write(currentPath, candidate);
    await ready(candidate.pid, candidate.ports, candidate.releaseHash);
    phase('succeeded', { resumePending: true });
    try { await call('resume'); } catch { /* The API retries the persisted handoff. */ }
  } catch (error) {
    job = read(jobPath);
    process.stderr.write(`${error instanceof Error ? error.message : 'Upgrade failed.'}\n`);
    if (['frozen', 'switching', 'recovering'].includes(job.phase)) {
      try { await recover(); }
      catch { phase('recovering', { error: '自动恢复尚未完成，请在本机查看升级日志并恢复此请求。' }); }
    } else {
      phase('failed', { resumePending: true, error: '升级未完成，现有版本未被替换。详情见本机升级日志。' });
      try { await call('resume'); } catch { /* Resume can be retried without repeating the upgrade. */ }
    }
  } finally { closeSync(log); rmSync(lockPath, { force: true }); }
}

if (command === 'prepare') process.stdout.write(JSON.stringify(prepare(...args)));
else if (command === 'install') await install(args[0]);
else if (command === 'run') await run(...args);
else throw new Error('Usage: upgrade-runner.mjs install <development|deployment> | run <state-directory> <job-id>');
