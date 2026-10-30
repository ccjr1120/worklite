// A page opened before a redeploy keeps running its old bundle: it calls API routes the new
// server may have renamed and lazy-loads chunk hashes that no longer exist. Before an in-app
// navigation, compare this bundle's version with the one the server reports and load the
// target page in full when they differ.
const CHECK_INTERVAL_MS = 30_000;
const RELOADED_FOR_KEY = 'worklite.staleBuild.reloadedFor';

type FetchVersion = () => Promise<string | null>;

type ReloadMemory = {
  get: () => string | null;
  set: (version: string) => void;
};

async function fetchServedVersion(): Promise<string | null> {
  const response = await fetch('/api/upgrades/runtime', { cache: 'no-store', credentials: 'include' });
  if (!response.ok) return null;
  const body = (await response.json()) as { version?: unknown };
  return typeof body.version === 'string' && body.version ? body.version : null;
}

const sessionReloadMemory: ReloadMemory = {
  get: () => {
    try { return window.sessionStorage.getItem(RELOADED_FOR_KEY); } catch { return null; }
  },
  set: (version) => {
    try { window.sessionStorage.setItem(RELOADED_FOR_KEY, version); } catch { /* reload still happens once per page */ }
  },
};

function createStaleBuildCheck(
  bundleVersion: string,
  fetchVersion: FetchVersion = fetchServedVersion,
  now = () => Date.now(),
  memory: ReloadMemory = sessionReloadMemory,
) {
  let checkedAt = Number.NEGATIVE_INFINITY;
  // Resolves true when the server runs a different release than this bundle and this tab has not
  // already reloaded for that release; a second mismatch after a reload means the served bundle
  // itself disagrees, and reloading again would loop. A failed or version-less answer (a
  // development server) never forces a reload.
  return async function shouldReload(): Promise<boolean> {
    if (now() - checkedAt < CHECK_INTERVAL_MS) return false;
    checkedAt = now();
    let served: string | null;
    try {
      served = await fetchVersion();
    } catch {
      return false;
    }
    if (served === null || served === bundleVersion || memory.get() === served) return false;
    memory.set(served);
    return true;
  };
}

export { createStaleBuildCheck, type ReloadMemory };
