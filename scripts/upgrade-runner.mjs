#!/usr/bin/env node
// Runs only after an operator installation command or a server-bound Chat redeploy request.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, lstatSync, readlinkSync, symlinkSync, chmodSync, rmSync, openSync, closeSync, writeSync } from 'node:fs';

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
  const gatewayConfigurationPath = 'apps/portkey-gateway/conf.json';
  if (!manifest.some((file) => file.path === gatewayConfigurationPath)) {
    const examplePath = join(projectRoot, 'apps/portkey-gateway/conf.example.json');
    const destination = join(root, gatewayConfigurationPath);
    const info = lstatSync(examplePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(examplePath, destination);
    chmodSync(destination, info.mode);
    manifest.push({ path: gatewayConfigurationPath, mode: info.mode, symlink: false, hash: createHash('sha256').update(readFileSync(destination)).digest('hex') });
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

function listeners(port) {
  try {
    return [...new Set(execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean).map(Number))];
  } catch (error) {
    if (error?.status === 1) return [];
    throw error;
  }
}

function processGroup(pid) {
  return Number(execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' }).trim());
}

function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}

function verifiedLegacyPid(runtime) {
  const pidPath = join(runtime.dataDirectory, 'worklite-local.pid');
  if (!existsSync(pidPath)) throw new Error('Deployment ports are occupied, and no legacy launcher PID file proves ownership.');
  const pid = Number(readFileSync(pidPath, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) throw new Error('Deployment ports are occupied, but the recorded legacy launcher PID is not active.');
  const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  const script = command.split(/\s+/).find((argument) => argument.includes('start-local.mjs'));
  if (!script || resolve(runtime.projectRoot, script) !== join(runtime.projectRoot, 'scripts/start-local.mjs')) throw new Error('The recorded PID is not this repository\'s legacy start-local.mjs process.');
  if (processGroup(pid) !== pid) throw new Error('The recorded legacy launcher is not the leader of its own process group.');
  const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split(/\r?\n/).find((line) => line.startsWith('n'))?.slice(1);
  if (!cwd || resolve(cwd) !== resolve(runtime.projectRoot)) throw new Error('The recorded legacy launcher does not run from this repository root.');
  const listening = runtime.ports.flatMap((port) => listeners(port).map((listenerPid) => ({ port, pid: listenerPid })));
  if (!listening.length || listening.some(({ pid: listenerPid }) => processGroup(listenerPid) !== pid)) throw new Error('Deployment port listeners do not all belong to the recorded legacy launcher process group.');
  return { pid, pidPath };
}

async function stopLegacyLauncher(runtime) {
  const { pid, pidPath } = verifiedLegacyPid(runtime);
  process.kill(-pid, 'SIGTERM');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && (groupAlive(pid) || runtime.ports.some((port) => listeners(port).length))) await sleep(100);
  if (groupAlive(pid)) {
    process.kill(-pid, 'SIGKILL');
    const killDeadline = Date.now() + 5_000;
    while (Date.now() < killDeadline && (groupAlive(pid) || runtime.ports.some((port) => listeners(port).length))) await sleep(100);
  }
  await portsFree(runtime.ports);
  rmSync(pidPath, { force: true });
}

async function freeTargetPorts(runtime) {
  const occupied = runtime.ports.some((port) => listeners(port).length > 0);
  if (!occupied) { await portsFree(runtime.ports); return; }
  await stopLegacyLauncher(runtime);
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
  // A one-time database VACUUM can keep a large deployment busy for minutes; an
  // exited runtime still fails immediately below.
  const deadline = Date.now() + 15 * 60_000;
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

async function stopImmediately(runtime) {
  if (!alive(runtime.pid)) return;
  const processCommand = execFileSync('ps', ['-p', String(runtime.pid), '-o', 'command='], { encoding: 'utf8' });
  if (!processCommand.includes(join(runtime.releaseDirectory, 'scripts/managed-runtime.mjs')) || processGroup(runtime.pid) !== runtime.pid) {
    throw new Error('The recorded PID is not the owned managed runtime process group; refusing to stop it.');
  }
  for (const port of runtime.ports) {
    for (const pid of listeners(port)) {
      if (processGroup(pid) !== runtime.pid) throw new Error(`Port ${port} has a listener outside the managed runtime process group; it was left untouched.`);
    }
  }
  process.kill(-runtime.pid, 'SIGKILL');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && runtime.ports.some((port) => listeners(port).length > 0)) await sleep(50);
  await portsFree(runtime.ports);
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
        if (header.toString() === 'SQLite format 3\0') { const database = new SQLite(from, { readonly: true }); try { await database.backup(to, { progress: () => 0x7fffffff }); } finally { database.close(); } }
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
  if (profile !== 'deployment') throw new Error('Select deployment explicitly.');
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dataDirectory = join(projectRoot, '.data', 'deployment');
  const stateDirectory = join(dataDirectory, 'runtime');
  const currentPath = join(stateDirectory, 'current.json');
  if (existsSync(currentPath)) throw new Error('A managed baseline already exists; use a confirmed upgrade request.');
  const id = `baseline_${randomUUID()}`;
  const release = prepare(projectRoot, stateDirectory, id);
  const runtime = { ...release, projectRoot, dataDirectory, stateDirectory, ports: [23390, 23391, 23392], preflightPorts: [23490, 23491, 23492] };
  const log = openSync(join(stateDirectory, 'install.log'), 'a', 0o600);
  try {
    await build(release.releaseDirectory, log);
    await preflight(runtime, release, log, id);
    await freeTargetPorts(runtime);
    const backup = join(stateDirectory, 'backups', id);
    await copyData(dataDirectory, backup, release.releaseDirectory);
    write(currentPath, runtime);
    runtime.pid = launch(runtime, dataDirectory, runtime.ports, false, log); write(currentPath, runtime);
    try { await ready(runtime.pid, runtime.ports, runtime.releaseHash); }
    catch (error) { await stop(runtime.pid, runtime.releaseDirectory); restoreData(backup, dataDirectory); rmSync(currentPath); throw error; }
    process.stdout.write(`Managed WorkLite baseline started on port ${runtime.ports[0]}.\n`);
  } finally { closeSync(log); }
}

function readActiveUpgrade(stateDirectory) {
  const activePath = join(stateDirectory, 'active.json');
  if (!existsSync(activePath)) return null;
  const { jobId } = read(activePath);
  return { id: jobId, ...read(join(stateDirectory, 'upgrades', `${jobId}.json`)) };
}

function verifiedOrphanGroups(runtime) {
  const groups = new Set();
  for (const port of runtime.ports) {
    for (const pid of listeners(port)) {
      const pgid = processGroup(pid);
      let command = '';
      try { command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); }
      catch { throw new Error(`Deployment port ${port} changed ownership during runtime recovery.`); }
      if (pgid !== runtime.pid || !command.includes(runtime.releaseDirectory)) throw new Error(`Deployment port ${port} is occupied by a process outside the recorded managed release; it was left untouched.`);
      groups.add(pgid);
    }
  }
  return [...groups];
}

async function stopOrphanGroups(runtime, groups) {
  for (const pgid of groups) {
    try { process.kill(-pgid, 'SIGKILL'); }
    catch (error) { if (error?.code !== 'ESRCH') throw error; }
    const groupHasTargetListener = () => runtime.ports.some((port) => listeners(port).some((pid) => {
      try { return processGroup(pid) === pgid; } catch { return false; }
    }));
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && groupHasTargetListener()) await sleep(50);
    if (groupHasTargetListener()) throw new Error('A verified orphan listener did not stop after interruption.');
  }
}

function assertNoActiveUpgrade(state) {
  const activePath = join(state, 'active.json');
  if (!existsSync(activePath)) return;
  const { jobId } = read(activePath);
  const active = read(join(state, 'upgrades', `${jobId}.json`));
  if (!['succeeded', 'rolled_back', 'failed'].includes(active.phase)) throw new Error('Another managed deployment is active.');
}

function describeError(error) {
  const details = [];
  const seen = new Set();
  let current = error;
  while (current instanceof Error && details.length < 4 && !seen.has(current)) {
    seen.add(current);
    const code = typeof current.code === 'string' ? ` [${current.code}]` : '';
    details.push(`${current.message}${code}`);
    current = current.cause;
  }
  return details.join(' <- ') || String(error);
}

async function fetchForUpgrade(url, options, action) {
  try { return await fetch(url, options); }
  catch (error) { throw new Error(`${action} request to ${url} failed: ${describeError(error)}`, { cause: error }); }
}

async function deploy(profile) {
  if (profile !== 'deployment') throw new Error('Select deployment explicitly.');
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dataDirectory = join(projectRoot, '.data', 'deployment');
  const stateDirectory = join(dataDirectory, 'runtime');
  const currentPath = join(stateDirectory, 'current.json');
  if (!existsSync(currentPath)) return install(profile);
  const current = read(currentPath);
  const expectedPorts = [23390, 23391, 23392];
  if (resolve(current.projectRoot) !== projectRoot || resolve(current.dataDirectory) !== dataDirectory || JSON.stringify(current.ports) !== JSON.stringify(expectedPorts)) throw new Error('The recorded managed baseline does not belong to this project profile.');
  const active = readActiveUpgrade(stateDirectory);
  const terminalPhases = ['succeeded', 'rolled_back', 'failed'];
  if (active && !terminalPhases.includes(active.phase)) throw new Error('Another managed deployment is active.');
  const id = `upgrade_${randomUUID()}`;
  const release = prepare(projectRoot, stateDirectory, id);
  let candidatePreflighted = false;
  const targetUnavailable = !alive(current.pid);
  if (targetUnavailable) {
    mkdirSync(join(stateDirectory, 'upgrades'), { recursive: true });
    const log = openSync(join(stateDirectory, 'upgrades', `${id}.log`), 'a', 0o600);
    try {
      assertRelease(current);
      await build(release.releaseDirectory, log);
      await preflight(current, release, log, id);
      // The candidate is ready before the recorded orphan groups are stopped.
      candidatePreflighted = true;
    } finally { closeSync(log); }
  }
  assertNoActiveUpgrade(stateDirectory);
  const now = new Date().toISOString();
  const job = {
    id, ...release, summary: 'Operator-requested local deployment', phase: 'authorized', workspaceId: 'operator',
    submissionId: id, executionId: 'operator', token: randomBytes(32).toString('hex'), pausedTeams: [], pausedWorkflows: [],
    confirmedAt: now, confirmedBy: 'pnpm deploy:local', updatedAt: now, interruptionPolicy: 'cancel_active_work_without_resume',
    ...(candidatePreflighted ? { candidatePreflighted: true } : {}), ...(targetUnavailable ? { targetUnavailable: true } : {}),
  };
  write(join(stateDirectory, 'upgrades', `${id}.json`), job);
  write(join(stateDirectory, 'active.json'), { jobId: id });
  await run(stateDirectory, id);
  const settled = read(join(stateDirectory, 'upgrades', `${id}.json`));
  if (settled.phase !== 'succeeded') throw new Error(settled.error || `Managed deployment ended in phase ${settled.phase}.`);
  process.stdout.write(`Managed WorkLite deployment completed on port ${current.ports[0]}.\n`);
}

async function run(state, id) {
  const jobPath = join(state, 'upgrades', `${id}.json`);
  let job = read(jobPath);
  if (!job.confirmedAt || job.releaseHash === undefined) throw new Error('A user-authorized deployment is required.');
  const lockPath = join(state, 'upgrade-runner.lock');
  if (existsSync(lockPath)) { const lock = read(lockPath); if (alive(lock.pid)) return; rmSync(lockPath); }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  const log = openSync(join(state, 'upgrades', `${id}.log`), 'a', 0o600);
  const currentPath = join(state, 'current.json');
  const current = read(currentPath);
  const previous = job.previous ?? current;
  const backup = join(state, 'backups', id);
  const phase = (value, extra = {}) => { job = { ...read(jobPath), ...extra, phase: value, runnerPid: process.pid, updatedAt: new Date().toISOString() }; write(jobPath, job); };
  let stage = 'upgrade initialization';
  const targetUrl = `http://127.0.0.1:${previous.ports[1]}/api/upgrades/runtime`;
  async function verifyTargetOwnership() {
    // The target API can stall for several seconds while the host is under build load;
    // 3s aborts an otherwise healthy runtime. Ownership is still verified after the wait.
    const response = await fetchForUpgrade(targetUrl, { signal: AbortSignal.timeout(15000) }, 'Target runtime ownership check');
    if (!response.ok) throw new Error(`Target runtime ownership check returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`);
    const ownership = await response.json();
    if (ownership.releaseHash !== previous.releaseHash || ownership.wrapperPid !== previous.pid) throw new Error('Target listeners are not owned by the recorded managed runtime.');
  }
  async function call(action) {
    const url = `http://127.0.0.1:${previous.ports[1]}/api/upgrades/${id}/${action}`;
    const response = await fetchForUpgrade(url, { method: 'POST', headers: { 'x-worklite-upgrade-token': job.token }, signal: AbortSignal.timeout(30_000) }, `Upgrade ${action}`);
    if (!response.ok) throw new Error(`Upgrade ${action} returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`);
    return response.json();
  }
  async function cancelLegacyHandoff() {
    if (job.executionId !== 'operator') throw new Error('The active runtime does not support immediate task cancellation; it was left running.');
    const latest = read(jobPath);
    const request = async (path, action) => {
      const response = await fetchForUpgrade(`http://127.0.0.1:${previous.ports[1]}${path}`, { method: 'POST', signal: AbortSignal.timeout(5_000) }, action);
      if (!response.ok) throw new Error(`${action} returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`);
      return response.json();
    };
    for (const runId of latest.pausedWorkflows ?? []) await request(`/api/runs/${encodeURIComponent(runId)}/cancel`, 'Workflow cancellation');
    for (const runId of latest.pausedTeams ?? []) await request(`/api/agent-teams/${encodeURIComponent(runId)}/cancel`, 'Team cancellation');
    const commandsResponse = await fetchForUpgrade(`http://127.0.0.1:${previous.ports[1]}/api/commands`, { signal: AbortSignal.timeout(5_000) }, 'Command list');
    if (!commandsResponse.ok) throw new Error(`Command list returned HTTP ${commandsResponse.status}${commandsResponse.statusText ? ` ${commandsResponse.statusText}` : ''}.`);
    const commandRows = await commandsResponse.json();
    const commands = Array.isArray(commandRows) ? commandRows : Array.isArray(commandRows.commands) ? commandRows.commands : [];
    const activeCommands = commands.filter((command) => ['queued', 'running', 'cancelling'].includes(command.status));
    for (const command of activeCommands) await request(`/api/commands/${encodeURIComponent(command.id)}/cancel`, 'Command cancellation');
    if (activeCommands.length) await sleep(1_200);
    const currentJob = read(jobPath);
    currentJob.interruptionPolicy = 'cancel_active_work_without_resume';
    currentJob.interruptedWork = {
      agentExecutions: [],
      teamRuns: [...new Set([...(currentJob.interruptedWork?.teamRuns ?? []), ...(latest.pausedTeams ?? [])])],
      workflowRuns: [...new Set([...(currentJob.interruptedWork?.workflowRuns ?? []), ...(latest.pausedWorkflows ?? [])])],
      commands: [...new Set([...(currentJob.interruptedWork?.commands ?? []), ...activeCommands.map((command) => command.id)])],
      feishuRegistration: false,
    };
    write(jobPath, currentJob);
  }
  async function recover() {
    stage = 'previous release recovery';
    phase('recovering');
    const running = read(currentPath);
    if (running.pid) await stopImmediately(running);
    if (job.backupComplete) restoreData(backup, previous.dataDirectory);
    await portsFree(previous.ports);
    previous.pid = launch(previous, previous.dataDirectory, previous.ports, false, log); write(currentPath, previous);
    await ready(previous.pid, previous.ports, previous.releaseHash);
    phase('rolled_back', { error: '新版本未完成切换，已恢复对应的旧版本和数据；被中断的任务不会自动恢复。详情见本机升级日志。' });
  }
  try {
    if (['frozen', 'switching', 'recovering'].includes(job.phase)) { await recover(); return; }
    phase('preflighting', { previous });
    stage = 'release integrity check';
    assertRelease(job);
    stage = 'target runtime availability check';
    if (!job.targetUnavailable) await verifyTargetOwnership();
    if (!job.candidatePreflighted) {
      stage = 'candidate build';
      await build(job.releaseDirectory, log);
      stage = 'isolated candidate preflight';
      await preflight(previous, job, log, id);
    }
    // No target process may be stopped before the isolated candidate is ready.
    stage = 'final target ownership check';
    if (!job.targetUnavailable) await verifyTargetOwnership();
    phase('draining');
    stage = 'interrupting active work';
    if (!job.targetUnavailable) {
      const handoff = await call('handoff');
      if (!handoff.interrupted) await cancelLegacyHandoff();
      else { stage = 'freezing runtime writes'; await call('freeze'); job = read(jobPath); }
    } else {
      const groups = verifiedOrphanGroups(previous);
      await stopOrphanGroups(previous, groups);
      await portsFree(previous.ports);
    }
    phase('frozen', { interruptionPolicy: 'cancel_active_work_without_resume' });
    stage = 'stopping previous release';
    await stopImmediately(previous);
    await portsFree(previous.ports);
    stage = 'deployment data backup';
    await copyData(previous.dataDirectory, backup, previous.releaseDirectory);
    phase('switching', { backupComplete: true });
    stage = 'starting candidate release';
    const candidate = { ...previous, releaseHash: job.releaseHash, releaseDirectory: job.releaseDirectory };
    candidate.pid = launch(candidate, candidate.dataDirectory, candidate.ports, false, log); write(currentPath, candidate);
    await ready(candidate.pid, candidate.ports, candidate.releaseHash);
    phase('succeeded', { interruptionPolicy: 'cancel_active_work_without_resume' });
    stage = 'reconnecting Feishu';
    try { await call('complete'); }
    catch (error) { writeSync(log, `Upgrade ${id} channel reconnect notice: ${describeError(error)}\n`); }
  } catch (error) {
    job = read(jobPath);
    const detail = describeError(error);
    const diagnostic = `Upgrade ${id} failed during "${stage}": ${detail}`;
    writeSync(log, `${diagnostic}\n`);
    process.stderr.write(`${diagnostic}\n`);
    if (['frozen', 'switching', 'recovering'].includes(job.phase)) {
      try { await recover(); }
      catch (recoveryError) {
        const recoveryDetail = describeError(recoveryError);
        writeSync(log, `Upgrade ${id} previous release recovery failed: ${recoveryDetail}\n`);
        phase('recovering', { error: `自动恢复尚未完成：${recoveryDetail}。原始失败：${detail}。详情见本机升级日志。` });
      }
    } else {
      phase('failed', { error: `升级在「${stage}」阶段失败：${detail}。现有版本未被替换；已经中断的任务不会自动恢复。详情见本机升级日志。` });
    }
  } finally { closeSync(log); rmSync(lockPath, { force: true }); }
}

if (command === 'prepare') process.stdout.write(JSON.stringify(prepare(...args)));
else if (command === 'install') await install(args[0]);
else if (command === 'deploy') await deploy(args[0]);
else if (command === 'run') await run(...args);
else throw new Error('Usage: upgrade-runner.mjs deploy <deployment> | install <deployment> | run <state-directory> <job-id>');
