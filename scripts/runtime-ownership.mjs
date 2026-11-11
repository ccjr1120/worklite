const transientCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

function transientTransportError(error) {
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current.name === 'TimeoutError' || transientCodes.has(current.code)) return true;
  }
  return false;
}

// Retry only this read-only probe. Handoff/freeze requests may have taken effect even
// when their response was lost and must not be replayed automatically.
export async function verifyRuntimeOwnership(runtime, {
  attempts = 3,
  timeoutMs = 15_000,
  delayMs = 500,
  onRetry = () => {},
} = {}) {
  const url = `http://127.0.0.1:${runtime.ports[1]}/api/upgrades/runtime`;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let ownership;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`Target runtime ownership check returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`);
      ownership = await response.json();
    } catch (error) {
      if (!transientTransportError(error) || attempt === attempts) {
        throw new Error(`Target runtime ownership check request to ${url} failed after ${attempt} attempt(s)`, { cause: error });
      }
      onRetry(error, attempt);
      await new Promise((done) => setTimeout(done, delayMs * attempt));
      continue;
    }
    const expectedIdentity = runtime.version ?? runtime.releaseHash;
    const actualIdentity = ownership?.version ?? ownership?.releaseHash;
    if (!expectedIdentity || actualIdentity !== expectedIdentity || ownership?.wrapperPid !== runtime.pid || ownership?.preflight) {
      throw new Error('Target listeners are not owned by the recorded managed runtime.');
    }
    return;
  }
}
