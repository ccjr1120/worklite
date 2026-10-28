#!/usr/bin/env node
// Runs only after an operator installation command or a server-bound Chat redeploy request.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, lstatSync, readlinkSync, symlinkSync, chmodSync, rmSync, openSync, closeSync, writeSync, statSync } from 'node:fs';
import { gatewayFingerprint } from './gateway-fingerprint.mjs';

const [command, ...args] = process.argv.slice(2);
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
function write(path, value) { mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, path); }
function alive(pid) { try { process.kill(pid, 0); return Number.isInteger(pid) && pid > 1; } catch { return false; } }
function runtimeRoot(runtime) {
  const root = runtime?.releaseDirectory ?? runtime?.projectRoot;
  if (!root) throw new Error('The managed runtime record has no project root.');
  return resolve(root);
}
function gatewayRoot(gateway, runtime) {
  return resolve(gateway?.supervisorDirectory ?? gateway?.releaseDirectory ?? gateway?.projectRoot ?? runtimeRoot(runtime));
}

// Each prepared release is a full working copy of the project plus the node_modules its
// build installs, so an unpruned releases/ directory grows by roughly a gigabyte per
// deployment. Upgrade job records and deployment logs accumulate the same way.
const TERMINAL_PHASES = ['succeeded', 'rolled_back', 'failed'];
function retentionBound(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}
function readIfPresent(path) {
  try { return existsSync(path) ? read(path) : null; } catch { return null; }
}

/**
 * A job still holds its release when it is the active one, when it is authorized and has not
 * settled, or while it is young enough to still be confirmed. A proposal the user never
 * confirmed would otherwise pin its release directory forever.
 */
function jobHoldsRelease(job, recordCutoff) {
  if (TERMINAL_PHASES.includes(job.phase)) return false;
  if (job.confirmedAt) return true;
  const proposedAt = Date.parse(job.updatedAt ?? '');
  return !Number.isFinite(proposedAt) || proposedAt >= recordCutoff;
}

/**
 * Every release directory that must survive pruning: the running deployment, the release a
 * pending or in-flight upgrade would start or fall back to, and the checkout this runner is
 * itself executing from.
 */
function protectedReleaseDirectories(state, extraIds = [], recordCutoff = 0) {
  const protectedPaths = new Set();
  const add = (value) => { if (typeof value === 'string' && value.trim()) protectedPaths.add(resolve(value)); };
  add(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  add(process.env.WORKLITE_RELEASE_ROOT);
  for (const id of extraIds) add(join(state, 'releases', id));
  const current = readIfPresent(join(state, 'current.json'));
  add(current?.releaseDirectory);
  add(current?.gateway?.releaseDirectory);
  add(current?.gateway?.supervisorDirectory);
  const active = readIfPresent(join(state, 'active.json'));
  if (active?.jobId) add(join(state, 'releases', active.jobId));
  const upgradesDirectory = join(state, 'upgrades');
  if (!existsSync(upgradesDirectory)) return protectedPaths;
  for (const entry of readdirSync(upgradesDirectory)) {
    if (!entry.endsWith('.json')) continue;
    const job = readIfPresent(join(upgradesDirectory, entry));
    if (!job) continue;
    if (jobHoldsRelease(job, recordCutoff)) { add(job.releaseDirectory); add(job.previous?.releaseDirectory); }
  }
  return protectedPaths;
}

function pruneReleases(state, extraIds = []) {
  const releasesDirectory = join(state, 'releases');
  if (!existsSync(releasesDirectory)) return;
  const keep = retentionBound('WORKLITE_RELEASE_RETENTION', 3);
  const protectedPaths = protectedReleaseDirectories(state, extraIds, recordCutoff());
  const candidates = [];
  for (const entry of readdirSync(releasesDirectory)) {
    const path = join(releasesDirectory, entry);
    if (protectedPaths.has(resolve(path))) continue;
    let modifiedAt = 0;
    try { const info = statSync(path); if (!info.isDirectory()) continue; modifiedAt = info.mtimeMs; } catch { continue; }
    candidates.push({ path, modifiedAt });
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const candidate of candidates.slice(keep)) {
    try { rmSync(candidate.path, { recursive: true, force: true }); } catch { /* a locked release is retried on the next deployment */ }
  }
}

function recordCutoff() {
  return Date.now() - retentionBound('WORKLITE_UPGRADE_RECORD_RETENTION_DAYS', 30) * 86_400_000;
}

function pruneUpgradeRecords(state) {
  const cutoff = recordCutoff();
  const activeJobId = readIfPresent(join(state, 'active.json'))?.jobId ?? null;
  const upgradesDirectory = join(state, 'upgrades');
  if (existsSync(upgradesDirectory)) for (const entry of readdirSync(upgradesDirectory)) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -'.json'.length);
    if (id === activeJobId) continue;
    const job = readIfPresent(join(upgradesDirectory, entry));
    // Settled jobs and proposals the user never confirmed both expire; an authorized job
    // that has not settled is live state and is kept whatever its age.
    if (!job || jobHoldsRelease(job, cutoff)) continue;
    const settledAt = Date.parse(job.updatedAt ?? '');
    if (!Number.isFinite(settledAt) || settledAt >= cutoff) continue;
    for (const path of [join(upgradesDirectory, entry), join(upgradesDirectory, `${id}.log`)]) {
      try { rmSync(path, { force: true }); } catch { /* retried on the next deployment */ }
    }
  }
  const deploymentsDirectory = join(state, 'deployments');
  if (existsSync(deploymentsDirectory)) for (const entry of readdirSync(deploymentsDirectory)) {
    if (!entry.endsWith('.log')) continue;
    const path = join(deploymentsDirectory, entry);
    try { if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true }); } catch { /* retried on the next deployment */ }
  }
}

/** Runtime state retention. Never writes to stdout: prepare's stdout is the release record the API parses. */
function pruneRuntimeState(state, extraIds = []) {
  try { pruneReleases(state, extraIds); } catch { /* retention failure must not fail a deployment */ }
  try { pruneUpgradeRecords(state); } catch { /* retention failure must not fail a deployment */ }
}

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
  const gatewayHash = gatewayFingerprint(manifest, process.env);
  write(join(root, 'release-manifest.json'), { releaseHash, gatewayHash, files: manifest });
  pruneRuntimeState(state, [id]);
  return { releaseHash, gatewayHash, releaseDirectory: root };
}

function assertRelease(release, verifyGatewayConfiguration = false) {
  const manifest = read(join(release.releaseDirectory, 'release-manifest.json'));
  if (manifest.releaseHash !== release.releaseHash || createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex') !== release.releaseHash) throw new Error('Release manifest changed.');
  if (release.gatewayHash && manifest.gatewayHash !== release.gatewayHash) throw new Error('Gateway release manifest changed.');
  if (verifyGatewayConfiguration && gatewayFingerprint(manifest.files, process.env) !== release.gatewayHash) throw new Error('Gateway configuration changed after the release was confirmed.');
  for (const file of manifest.files) {
    const path = join(release.releaseDirectory, file.path);
    const hash = createHash('sha256').update(file.symlink ? readlinkSync(path) : readFileSync(path)).digest('hex');
    if (hash !== file.hash || lstatSync(path).mode !== file.mode) throw new Error('Release source changed after confirmation.');
  }
}

function releaseGatewayHash(release) {
  // The immutable release manifest is authoritative; runtime summary fields can lag behind it.
  if (release.releaseDirectory) {
    const manifestPath = join(release.releaseDirectory, 'release-manifest.json');
    if (existsSync(manifestPath)) {
      const manifest = read(manifestPath);
      return manifest.gatewayHash ?? gatewayFingerprint(manifest.files, process.env);
    }
  }
  return release.gatewayHash ?? null;
}

function runtimeGatewayHash(runtime) {
  const gateway = runtime?.gateway;
  if (!gateway) return releaseGatewayHash(runtime);

  // Compare against the release actually serving Gateway traffic, not the API/Web release.
  const gatewayReleaseDirectory = gateway.releaseDirectory ?? gateway.supervisorDirectory ?? gateway.projectRoot;
  if (gatewayReleaseDirectory) {
    const hash = releaseGatewayHash({ releaseDirectory: gatewayReleaseDirectory });
    if (hash) return hash;
  }
  return gateway.gatewayHash ?? releaseGatewayHash(runtime);
}

async function withRouteTreeRestored(root, operation) {
  const routeTreePath = join(root, 'apps/web/src/routeTree.gen.ts');
  const routeTree = existsSync(routeTreePath)
    ? { content: readFileSync(routeTreePath), mode: lstatSync(routeTreePath).mode }
    : null;
  try {
    return await operation();
  } finally {
    if (routeTree) {
      writeFileSync(routeTreePath, routeTree.content);
      chmodSync(routeTreePath, routeTree.mode & 0o7777);
    }
  }
}

async function build(root, log) {
  await withRouteTreeRestored(root, async () => {
    for (const argv of [
      ['install', '--frozen-lockfile'],
      ['--filter', '@portkey-ai/gateway', 'build'],
      ['--filter', '@worklite/api', 'exec', 'nest', 'build', '--builder', 'webpack', '--webpackPath', 'webpack.config.js'],
      ['--filter', '@worklite/web', 'exec', 'vite', 'build'],
    ]) await new Promise((done, fail) => {
      const child = spawn('pnpm', argv, { cwd: root, env: process.env, stdio: ['ignore', log, log] });
      child.once('error', fail); child.once('exit', (code) => code === 0 ? done() : fail(new Error('Project compilation failed; see the deployment log.')));
    });
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

function processGroupPids(pgid) {
  return execFileSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' }).trim().split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, group]) => Number.isInteger(pid) && group === pgid)
    .map(([pid]) => pid);
}

function canKeepGateway(gateway) {
  if (!gateway?.pid || !alive(gateway.pid)) return false;
  return listeners(gateway.port).every((pid) => processGroup(pid) === gateway.pid);
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

function readCurrentRuntime(currentPath, projectRoot, dataDirectory, stateDirectory, ports) {
  if (!existsSync(currentPath)) return null;
  const current = read(currentPath);
  if (current.projectRoot && resolve(current.projectRoot) !== projectRoot) throw new Error('The recorded managed baseline does not belong to this project profile.');
  if (current.dataDirectory && resolve(current.dataDirectory) !== dataDirectory) throw new Error('The recorded managed baseline does not belong to this deployment data directory.');
  if (current.stateDirectory && resolve(current.stateDirectory) !== stateDirectory) throw new Error('The recorded managed baseline does not belong to this runtime state directory.');
  if (current.ports && JSON.stringify(current.ports) !== JSON.stringify(ports)) throw new Error('The recorded managed baseline uses different deployment ports.');
  return { ...current, projectRoot, dataDirectory, stateDirectory, ports };
}

function assertCurrentOwnership(runtime) {
  const root = runtimeRoot(runtime);
  if (alive(runtime.pid)) {
    const command = execFileSync('ps', ['-p', String(runtime.pid), '-o', 'command='], { encoding: 'utf8' }).trim();
    if (!command.includes(join(root, 'scripts/managed-runtime.mjs')) || processGroup(runtime.pid) !== runtime.pid) {
      throw new Error('The recorded PID is not the owned managed runtime process group; deployment ports were left untouched.');
    }
  }

  const gateway = runtime.gateway;
  let gatewayGroup = runtime.pid;
  let gatewayDirectory = root;
  if (gateway) {
    gatewayDirectory = gatewayRoot(gateway, runtime);
    if (gateway.legacyProcessGroup) {
      gatewayGroup = gateway.legacyProcessGroup;
      if (alive(gateway.pid)) {
        const command = execFileSync('ps', ['-p', String(gateway.pid), '-o', 'command='], { encoding: 'utf8' }).trim();
        if (processGroup(gateway.pid) !== gatewayGroup || !command.includes('build/start-server.js') || !command.includes(gatewayDirectory)) {
          throw new Error('The recorded legacy Gateway PID is not owned by the recorded project; deployment ports were left untouched.');
        }
      }
    } else if (gateway.pid && alive(gateway.pid)) {
      const command = execFileSync('ps', ['-p', String(gateway.pid), '-o', 'command='], { encoding: 'utf8' }).trim();
      if (!command.includes(join(gatewayDirectory, 'scripts/managed-gateway.mjs')) || processGroup(gateway.pid) !== gateway.pid) {
        throw new Error('The recorded PID is not the owned managed Gateway supervisor; deployment ports were left untouched.');
      }
      gatewayGroup = gateway.pid;
    } else if (gateway.pid) {
      gatewayGroup = gateway.pid;
    } else {
      throw new Error('The recorded managed Gateway has no verifiable process identity; deployment ports were left untouched.');
    }
  }

  for (const [index, port] of runtime.ports.entries()) {
    const expectedGroup = index === 2 ? gatewayGroup : runtime.pid;
    const expectedRoot = index === 2 ? gatewayDirectory : root;
    for (const pid of listeners(port)) {
      const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
      const gatewayChild = index === 2 && command.includes('build/start-server.js');
      if (!expectedGroup || processGroup(pid) !== expectedGroup || !command.includes(expectedRoot) || (index === 2 && !gatewayChild)) {
        throw new Error(`Deployment port ${port} has a listener outside the recorded managed runtime; it was left untouched.`);
      }
    }
  }
}

function profileEnvironment(runtime, data, ports, preflight) {
  const environment = { ...process.env, API_HOST: '127.0.0.1', WEB_PORT: String(ports[0]), API_PORT: String(ports[1]), PORTKEY_GATEWAY_PORT: String(ports[2]),
    SQLITE_PATH: join(data, 'worklite.db'), PORTKEY_GATEWAY_DB_PATH: join(data, 'worklite-gateway.db'), AGENT_TEAM_CHECKPOINT_PATH: join(data, 'agent-teams/checkpoints.sqlite'),
    WORKLITE_RELEASE_ROOT: runtimeRoot(runtime), WORKLITE_PROJECT_ROOT: runtime.projectRoot ?? runtimeRoot(runtime), WORKLITE_VERSION: runtime.version ?? '',
    WORKLITE_RUNTIME_STATE_DIR: preflight ? '' : runtime.stateDirectory, WORKLITE_PREFLIGHT: preflight ? '1' : '0', WORKLITE_MANAGED_GATEWAY: '1' };
  if (runtime.releaseHash) environment.WORKLITE_RELEASE_HASH = runtime.releaseHash;
  else delete environment.WORKLITE_RELEASE_HASH;
  if (!runtime.version) delete environment.WORKLITE_VERSION;
  return environment;
}

function launch(runtime, data, ports, preflight, log) {
  const root = runtimeRoot(runtime);
  const child = spawn(process.execPath, [join(root, 'scripts/managed-runtime.mjs')], { cwd: root, env: profileEnvironment(runtime, data, ports, preflight), detached: true, stdio: ['ignore', log, log] });
  child.unref(); return child.pid;
}

function launchGateway(runtime, data, port, preflight, log, supervisorDirectory = runtimeRoot(runtime)) {
  const root = runtimeRoot(runtime);
  const environment = {
    ...process.env,
    PORTKEY_GATEWAY_PORT: String(port),
    TRUSTED_CUSTOM_HOSTS: process.env.PORTKEY_TRUSTED_CUSTOM_HOSTS?.trim() || 'localhost,127.0.0.1,::1,host.docker.internal',
    PORTKEY_GATEWAY_DB_PATH: join(data, 'worklite-gateway.db'),
    WORKLITE_RELEASE_ROOT: root,
    WORKLITE_PROJECT_ROOT: runtime.projectRoot ?? root,
    WORKLITE_VERSION: runtime.version ?? '',
    WORKLITE_DATA_DIRECTORY: data,
    WORKLITE_PREFLIGHT: preflight ? '1' : '0',
  };
  if (runtime.releaseHash) environment.WORKLITE_RELEASE_HASH = runtime.releaseHash;
  else delete environment.WORKLITE_RELEASE_HASH;
  if (runtime.gatewayHash) environment.WORKLITE_GATEWAY_HASH = runtime.gatewayHash;
  else delete environment.WORKLITE_GATEWAY_HASH;
  if (!runtime.version) delete environment.WORKLITE_VERSION;
  const child = spawn(process.execPath, [join(supervisorDirectory, 'scripts/managed-gateway.mjs')], {
    cwd: supervisorDirectory,
    env: environment,
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  return { pid: child.pid, port, gatewayHash: runtime.gatewayHash ?? null, releaseHash: runtime.releaseHash, version: runtime.version, supervisorDirectory,
    ...(runtime.releaseDirectory ? { releaseDirectory: runtime.releaseDirectory } : {}) };
}

async function gatewayReady(gateway, requireIdentity = true) {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    if (!alive(gateway.pid)) throw new Error('The managed Gateway exited before readiness.');
    try {
      const root = await fetch(`http://127.0.0.1:${gateway.port}/`, { signal: AbortSignal.timeout(1000) });
      const runtime = requireIdentity
        ? await fetch(`http://127.0.0.1:${gateway.port}/worklite/runtime`, { signal: AbortSignal.timeout(1000) })
        : null;
      if (root.ok && (!requireIdentity || runtime?.ok)) {
        const identity = runtime ? await runtime.json() : null;
        if (!requireIdentity || (identity.gatewayHash === gateway.gatewayHash && identity.wrapperPid === gateway.pid)) {
          const owners = listeners(gateway.port);
          if (owners.length > 0 && owners.every((pid) => processGroup(pid) === gateway.pid)) return;
        }
      }
    } catch { /* The candidate Gateway is still starting. */ }
    await sleep(250);
  }
  throw new Error(`Gateway readiness timed out on port ${gateway.port}.`);
}

async function ready(pid, ports, hash, gateway) {
  // A one-time database VACUUM can keep a large deployment busy for minutes; an
  // exited runtime still fails immediately below.
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    if (!alive(pid)) throw new Error('The managed runtime exited before readiness.');
    try {
      const responses = await Promise.all([fetch(`http://127.0.0.1:${ports[0]}/`, { signal: AbortSignal.timeout(1000) }), fetch(`http://127.0.0.1:${ports[1]}/api/upgrades/runtime`, { signal: AbortSignal.timeout(1000) }), fetch(`http://127.0.0.1:${ports[2]}/worklite/runtime`, { signal: AbortSignal.timeout(1000) })]);
      if (responses.every((response) => response.ok)) {
        const runtime = await responses[1].json();
        const gatewayRuntime = await responses[2].json();
        if ((runtime.releaseHash === hash || runtime.version === hash) && runtime.wrapperPid === pid && gatewayRuntime.gatewayHash === gateway.gatewayHash && gatewayRuntime.wrapperPid === gateway.pid) {
          const listenersOwned = ports.slice(0, 2).every((port) => {
            const listeners = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
            return listeners.length > 0 && listeners.every((listener) => Number(execFileSync('ps', ['-p', listener, '-o', 'pgid='], { encoding: 'utf8' }).trim()) === pid);
          });
          const gatewayListeners = listeners(ports[2]);
          if (listenersOwned && gatewayListeners.length > 0 && gatewayListeners.every((listener) => processGroup(listener) === gateway.pid)) return;
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

async function stopGateway(gateway) {
  if (!gateway) return;
  const root = gatewayRoot(gateway, gateway);
  if (!gateway.pid || !alive(gateway.pid)) {
    const ownerGroup = gateway.legacyProcessGroup ?? gateway.pid;
    const owners = listeners(gateway.port);
    if (owners.length > 0) {
      for (const pid of owners) {
        const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
        if (!ownerGroup || processGroup(pid) !== ownerGroup || !command.includes('build/start-server.js') || !command.includes(root)) {
          throw new Error(`Gateway port ${gateway.port} has an unowned listener; it was left untouched.`);
        }
      }
      try { process.kill(-ownerGroup, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && listeners(gateway.port).length > 0) await sleep(50);
    }
    await portsFree([gateway.port]);
    return;
  }
  if (gateway.legacyProcessGroup) {
    const command = execFileSync('ps', ['-p', String(gateway.pid), '-o', 'command='], { encoding: 'utf8' });
    if (processGroup(gateway.pid) !== gateway.legacyProcessGroup || !command.includes('build/start-server.js') || !command.includes(root)) {
      throw new Error('The recorded legacy Gateway PID is not owned by the expected release; refusing to stop it.');
    }
    if (listeners(gateway.port).some((pid) => pid !== gateway.pid)) throw new Error(`Gateway port ${gateway.port} has an unexpected listener; it was left untouched.`);
    process.kill(gateway.pid, 'SIGTERM');
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && listeners(gateway.port).length > 0) await sleep(100);
    if (listeners(gateway.port).length > 0 && alive(gateway.pid)) process.kill(gateway.pid, 'SIGKILL');
    await portsFree([gateway.port]);
    return;
  }
  const processCommand = execFileSync('ps', ['-p', String(gateway.pid), '-o', 'command='], { encoding: 'utf8' });
  if (!processCommand.includes(join(gateway.supervisorDirectory ?? root, 'scripts/managed-gateway.mjs')) || processGroup(gateway.pid) !== gateway.pid) {
    throw new Error('The recorded PID is not the owned managed Gateway supervisor; refusing to stop it.');
  }
  for (const pid of listeners(gateway.port)) {
    if (processGroup(pid) !== gateway.pid) throw new Error(`Gateway port ${gateway.port} has a listener outside the managed Gateway process group; it was left untouched.`);
  }
  process.kill(gateway.pid, 'SIGTERM');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && (groupAlive(gateway.pid) || listeners(gateway.port).length > 0)) await sleep(100);
  if (groupAlive(gateway.pid)) {
    try { process.kill(-gateway.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  }
  const killDeadline = Date.now() + 5_000;
  while (Date.now() < killDeadline && (groupAlive(gateway.pid) || listeners(gateway.port).length > 0)) await sleep(100);
  await portsFree([gateway.port]);
}

async function stopImmediately(runtime, { preserveLegacyGateway = false } = {}) {
  if (!alive(runtime.pid)) return;
  const root = runtimeRoot(runtime);
  const processCommand = execFileSync('ps', ['-p', String(runtime.pid), '-o', 'command='], { encoding: 'utf8' });
  if (!processCommand.includes(join(root, 'scripts/managed-runtime.mjs')) || processGroup(runtime.pid) !== runtime.pid) {
    throw new Error('The recorded PID is not the owned managed runtime process group; refusing to stop it.');
  }
  let preservedGatewayPid;
  if (preserveLegacyGateway && !runtime.gateway) {
    const gatewayListeners = listeners(runtime.ports[2]);
    if (gatewayListeners.length !== 1 || processGroup(gatewayListeners[0]) !== runtime.pid) throw new Error('The legacy Gateway listener cannot be isolated safely from the managed runtime.');
    const gatewayCommand = execFileSync('ps', ['-p', String(gatewayListeners[0]), '-o', 'command='], { encoding: 'utf8' });
    if (!gatewayCommand.includes('build/start-server.js') || !gatewayCommand.includes(root)) throw new Error('The legacy Gateway listener is not owned by the recorded project root.');
    preservedGatewayPid = gatewayListeners[0];
  }
  const runtimePorts = runtime.gateway || preservedGatewayPid ? runtime.ports.slice(0, 2) : runtime.ports;
  for (const port of runtimePorts) {
    for (const pid of listeners(port)) {
      if (processGroup(pid) !== runtime.pid) throw new Error(`Port ${port} has a listener outside the managed runtime process group; it was left untouched.`);
    }
  }
  if (preservedGatewayPid) {
    for (const pid of processGroupPids(runtime.pid)) if (pid !== preservedGatewayPid) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
    }
  } else {
    process.kill(-runtime.pid, 'SIGKILL');
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && runtimePorts.some((port) => listeners(port).length > 0)) await sleep(50);
  await portsFree(runtimePorts);
  if (preservedGatewayPid && listeners(runtime.ports[2]).some((pid) => pid !== preservedGatewayPid)) throw new Error('The preserved legacy Gateway port changed ownership during cutover.');
}

async function preflight(runtime, release, log, id) {
  const data = join(runtime.stateDirectory, 'preflight', id);
  const preflightPorts = runtime.preflightPorts ?? [23490, 23491, 23492];
  await portsFree(preflightPorts);
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  const candidate = { ...runtime, ...release };
  let pid;
  let gateway;
  try {
    await withRouteTreeRestored(candidate.releaseDirectory, async () => {
      try {
        gateway = launchGateway(candidate, data, preflightPorts[2], true, log);
        await gatewayReady(gateway);
        pid = launch(candidate, data, preflightPorts, true, log);
        await ready(pid, preflightPorts, candidate.releaseHash, gateway);
      } finally {
        if (pid) await stop(pid, candidate.releaseDirectory);
        if (gateway) await stopGateway(gateway);
      }
    });
  } finally { rmSync(data, { recursive: true, force: true }); }
}

async function install(profile) {
  if (profile !== 'deployment') throw new Error('Select deployment explicitly.');
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dataDirectory = join(projectRoot, '.data', 'deployment');
  const stateDirectory = join(dataDirectory, 'runtime');
  const currentPath = join(stateDirectory, 'current.json');
  if (existsSync(currentPath)) throw new Error('A managed baseline already exists; use a confirmed upgrade request.');
  const runtime = { projectRoot, dataDirectory, stateDirectory, version: read(join(projectRoot, 'apps/web/package.json')).version, ports: [23390, 23391, 23392], gatewayHash: null };
  const logDirectory = join(stateDirectory, 'deployments');
  mkdirSync(logDirectory, { recursive: true });
  const log = openSync(join(logDirectory, `${randomUUID()}.log`), 'a', 0o600);
  try {
    await build(projectRoot, log);
    await freeTargetPorts(runtime);
    runtime.gateway = launchGateway(runtime, dataDirectory, runtime.ports[2], false, log);
    try {
      await gatewayReady(runtime.gateway);
      runtime.pid = launch(runtime, dataDirectory, runtime.ports, false, log);
      await ready(runtime.pid, runtime.ports, runtime.version, runtime.gateway);
      write(currentPath, runtime);
    } catch (error) {
      if (runtime.pid) await stopImmediately(runtime);
      await stopGateway(runtime.gateway);
      throw error;
    }
    process.stdout.write(`Managed WorkLite deployment started on port ${runtime.ports[0]} at version ${runtime.version}.\n`);
  } finally { closeSync(log); pruneRuntimeState(stateDirectory); }
}

function verifiedOrphanGroups(runtime) {
  const groups = new Set();
  const root = runtimeRoot(runtime);
  for (const port of (runtime.gateway ? runtime.ports.slice(0, 2) : runtime.ports)) {
    for (const pid of listeners(port)) {
      const pgid = processGroup(pid);
      let command = '';
      try { command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); }
      catch { throw new Error(`Deployment port ${port} changed ownership during runtime recovery.`); }
      if (pgid !== runtime.pid || !command.includes(root)) throw new Error(`Deployment port ${port} is occupied by a process outside the recorded managed project; it was left untouched.`);
      groups.add(pgid);
    }
  }
  return [...groups];
}

async function stopOrphanGroups(runtime, groups, preservedGatewayPid) {
  for (const pgid of groups) {
    if (preservedGatewayPid && processGroup(preservedGatewayPid) === pgid) {
      for (const pid of processGroupPids(pgid)) if (pid !== preservedGatewayPid) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
      }
    } else {
      try { process.kill(-pgid, 'SIGKILL'); }
      catch (error) { if (error?.code !== 'ESRCH') throw error; }
    }
    const targetPorts = preservedGatewayPid || runtime.gateway ? runtime.ports.slice(0, 2) : runtime.ports;
    const groupHasTargetListener = () => targetPorts.some((port) => listeners(port).some((pid) => {
      try { return processGroup(pid) === pgid; } catch { return false; }
    }));
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && groupHasTargetListener()) await sleep(50);
    if (groupHasTargetListener()) throw new Error('A verified orphan listener did not stop after interruption.');
  }
}

function legacyGatewayRecord(runtime, gatewayHash) {
  const root = runtimeRoot(runtime);
  const gatewayListeners = listeners(runtime.ports[2]);
  if (gatewayListeners.length !== 1 || processGroup(gatewayListeners[0]) !== runtime.pid) return null;
  const command = execFileSync('ps', ['-p', String(gatewayListeners[0]), '-o', 'command='], { encoding: 'utf8' });
  if (!command.includes('build/start-server.js') || !command.includes(root)) return null;
  return { pid: gatewayListeners[0], port: runtime.ports[2], gatewayHash, releaseHash: runtime.releaseHash, projectRoot: runtime.projectRoot, releaseDirectory: runtime.releaseDirectory, legacyProcessGroup: runtime.pid };
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
  const expectedPorts = [23390, 23391, 23392];
  const current = readCurrentRuntime(currentPath, projectRoot, dataDirectory, stateDirectory, expectedPorts);
  if (!current) return install(profile);
  assertNoActiveUpgrade(stateDirectory);

  const runtime = { projectRoot, dataDirectory, stateDirectory, version: read(join(projectRoot, 'apps/web/package.json')).version, ports: expectedPorts, gatewayHash: null };
  const logDirectory = join(stateDirectory, 'deployments');
  mkdirSync(logDirectory, { recursive: true });
  const log = openSync(join(logDirectory, `${randomUUID()}.log`), 'a', 0o600);
  let committed = false;
  try {
    await build(projectRoot, log);

    // Verify every existing owner before stopping any service, so a foreign listener
    // can never cause a partial stop of the recorded deployment.
    assertCurrentOwnership(current);
    if (current.gateway) await stopGateway(current.gateway);
    if (alive(current.pid)) await stopImmediately(current);
    else await stopOrphanGroups(current, verifiedOrphanGroups(current), null);
    await portsFree(expectedPorts);

    runtime.gateway = launchGateway(runtime, dataDirectory, runtime.ports[2], false, log);
    await gatewayReady(runtime.gateway);
    runtime.pid = launch(runtime, dataDirectory, runtime.ports, false, log);
    await ready(runtime.pid, runtime.ports, runtime.version, runtime.gateway);

    // current.json describes the last deployment that reached readiness.
    write(currentPath, runtime);
    committed = true;
  } catch (error) {
    const cleanupErrors = [];
    if (!committed && runtime.pid) {
      try {
        if (alive(runtime.pid)) await stopImmediately(runtime);
        else await stopOrphanGroups(runtime, verifiedOrphanGroups(runtime), null);
      } catch (cleanupError) { cleanupErrors.push(describeError(cleanupError)); }
    }
    if (!committed && runtime.gateway) {
      try { await stopGateway(runtime.gateway); }
      catch (cleanupError) { cleanupErrors.push(describeError(cleanupError)); }
    }
    if (cleanupErrors.length) throw new Error(`${describeError(error)} Candidate cleanup also failed: ${cleanupErrors.join('; ')}.`, { cause: error });
    throw error;
  } finally {
    closeSync(log);
    // Retention runs on every deployment attempt, not only the ones that reach readiness:
    // a failed attempt leaves a release directory and a deployment log of its own behind.
    pruneRuntimeState(stateDirectory);
  }
  process.stdout.write(`Managed WorkLite deployment completed on port ${runtime.ports[0]} at version ${runtime.version}.\n`);
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
  const phase = (value, extra = {}) => { job = { ...read(jobPath), ...extra, phase: value, runnerPid: process.pid, updatedAt: new Date().toISOString() }; write(jobPath, job); };
  let stage = 'upgrade initialization';
  const candidateGatewayHash = releaseGatewayHash(job);
  const previousGatewayHash = runtimeGatewayHash(previous);
  const gatewayHasChanged = candidateGatewayHash !== previousGatewayHash;
  let previousGatewayStopped = false;
  let candidateGateway;
  let keptGateway = null;
  const targetUrl = `http://127.0.0.1:${previous.ports[1]}/api/upgrades/runtime`;
  async function verifyTargetOwnership() {
    // The target API can stall for several seconds while the host is under build load;
    // 3s aborts an otherwise healthy runtime. Ownership is still verified after the wait.
    const response = await fetchForUpgrade(targetUrl, { signal: AbortSignal.timeout(15000) }, 'Target runtime ownership check');
    if (!response.ok) throw new Error(`Target runtime ownership check returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`);
    const ownership = await response.json();
    const expectedIdentity = previous.version ?? previous.releaseHash;
    const actualIdentity = ownership.version ?? ownership.releaseHash;
    if (actualIdentity !== expectedIdentity || ownership.wrapperPid !== previous.pid) throw new Error('Target listeners are not owned by the recorded managed runtime.');
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
    // Only active commands are cancelled here, and the unfiltered list is the whole command
    // history: asking for the full table during a drain made this call scale with history size.
    const commandsResponse = await fetchForUpgrade(`http://127.0.0.1:${previous.ports[1]}/api/commands?status=active`, { signal: AbortSignal.timeout(5_000) }, 'Command list');
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
  async function stopFailedCandidate() {
    const running = read(currentPath);
    let details = [];
    if (running?.pid && running.releaseDirectory && resolve(running.releaseDirectory) === resolve(job.releaseDirectory)) {
      try { await stopImmediately(running); }
      catch (error) { details.push(describeError(error)); }
    }
    if (candidateGateway) {
      try { await stopGateway(candidateGateway); candidateGateway = null; }
      catch (error) { details.push(describeError(error)); }
    }
    return details.length ? details.join('; ') : null;
  }
  async function restorePreviousGateway() {
    if (!gatewayHasChanged || !previousGatewayStopped) return null;
    try {
      const supervisorDirectory = previous.gateway ? gatewayRoot(previous.gateway, previous) : runtimeRoot(previous);
      const restored = launchGateway({ ...previous, gatewayHash: previousGatewayHash }, previous.dataDirectory, previous.ports[2], false, log, supervisorDirectory);
      await gatewayReady(restored, Boolean(previous.gateway));
      const active = read(currentPath);
      if (active) { active.gateway = restored; active.gatewayHash = previousGatewayHash; write(currentPath, active); }
      writeSync(log, `Restored previous Gateway ${previousGatewayHash} on port ${previous.ports[2]}.\n`);
      return null;
    } catch (error) {
      return describeError(error);
    }
  }
  async function failCutover(detail) {
    const stopError = await stopFailedCandidate();
    const stopNotice = stopError ? ' 候选服务停止失败：' + stopError + '。' : '';
    const recoveryError = await restorePreviousGateway();
    const recoveryNotice = recoveryError ? ` 旧 Gateway 恢复失败：${recoveryError}。` : previousGatewayStopped ? ' 已恢复旧 Gateway。' : '';
    phase('failed', { error: '升级在「' + stage + '」阶段失败：' + detail + '。未自动恢复旧 API/Web 或数据库；数据库可能已被部分迁移。' + recoveryNotice + stopNotice + '请检查当前部署和升级日志，并手动修复或重新部署。' });
  }
  try {
    if (['frozen', 'switching', 'recovering'].includes(job.phase)) {
      stage = 'interrupted cutover review';
      await failCutover('升级执行器中断于「' + job.phase + '」阶段');
      return;
    }
    phase('preflighting', { previous });
    stage = 'release integrity check';
    assertRelease(job, true);
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
      const legacyGateway = !previous.gateway && !gatewayHasChanged ? legacyGatewayRecord(previous, previousGatewayHash) : null;
      const managedGateway = canKeepGateway(previous.gateway) ? previous.gateway : null;
      keptGateway = !gatewayHasChanged ? managedGateway ?? legacyGateway : null;
      const groups = verifiedOrphanGroups(previous);
      await stopOrphanGroups(previous, groups, legacyGateway?.pid);
      await portsFree(previous.ports.slice(0, 2));
      if (previous.gateway && !keptGateway) {
        await stopGateway(previous.gateway);
        previousGatewayStopped = gatewayHasChanged;
      } else if (gatewayHasChanged) {
        previousGatewayStopped = true;
      }
    }
    phase('frozen', { interruptionPolicy: 'cancel_active_work_without_resume' });
    stage = 'stopping previous release';
    if (!job.targetUnavailable) {
      const legacyGateway = !previous.gateway && !gatewayHasChanged ? legacyGatewayRecord(previous, previousGatewayHash) : null;
      const managedGateway = canKeepGateway(previous.gateway) ? previous.gateway : null;
      keptGateway = !gatewayHasChanged ? managedGateway ?? legacyGateway : null;
      if (previous.gateway && !keptGateway) {
        await stopGateway(previous.gateway);
        previousGatewayStopped = gatewayHasChanged;
      } else if (gatewayHasChanged) {
        previousGatewayStopped = true;
      }
      await stopImmediately(previous, { preserveLegacyGateway: Boolean(keptGateway && !previous.gateway) });
      await portsFree(previous.ports.slice(0, 2));
      if (!previous.gateway && gatewayHasChanged) previousGatewayStopped = true;
    }
    if (!keptGateway) await portsFree([previous.ports[2]]);
    phase('switching');
    stage = 'starting candidate release';
    const candidate = { ...previous, version: read(join(job.releaseDirectory, 'apps/web/package.json')).version, releaseHash: job.releaseHash, gatewayHash: candidateGatewayHash, releaseDirectory: job.releaseDirectory };
    if (keptGateway) {
      candidate.gateway = keptGateway;
    } else {
      candidateGateway = launchGateway(candidate, candidate.dataDirectory, candidate.ports[2], false, log);
      candidate.gateway = candidateGateway;
      await gatewayReady(candidateGateway);
    }
    candidate.pid = launch(candidate, candidate.dataDirectory, candidate.ports, false, log);
    write(currentPath, candidate);
    await ready(candidate.pid, candidate.ports, candidate.releaseHash, candidate.gateway);
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
      await failCutover(detail);
    } else {
      phase('failed', { error: '升级在「' + stage + '」阶段失败：' + detail + '。切换尚未开始，现有运行版本未被替换；已经中断的任务不会自动恢复。详情见本机升级日志。' });
    }
  } finally {
    // Whichever branch the upgrade ended in, current.json now names the release that is
    // running, so retention keeps it and the newest fallbacks and reclaims the rest.
    pruneRuntimeState(state);
    closeSync(log);
    rmSync(lockPath, { force: true });
  }
}

if (command === 'prepare') process.stdout.write(JSON.stringify(prepare(...args)));
else if (command === 'install') await install(args[0]);
else if (command === 'deploy') await deploy(args[0]);
else if (command === 'run') await run(...args);
else throw new Error('Usage: upgrade-runner.mjs deploy <deployment> | install <deployment> | run <state-directory> <job-id>');
