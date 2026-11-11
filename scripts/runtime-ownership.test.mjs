import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { verifyRuntimeOwnership } from './runtime-ownership.mjs';

const identity = { version: 'test', wrapperPid: 123, preflight: false };

async function probe(t, handler, options = {}) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const runtime = { version: 'test', pid: 123, ports: [0, server.address().port, 0] };
  return verifyRuntimeOwnership(runtime, { delayMs: 1, ...options });
}

test('recovers from a real socket reset and verifies the recovered identity', async (t) => {
  let requests = 0;
  let retries = 0;
  await probe(t, (req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/upgrades/runtime');
    if (++requests === 1) req.socket.destroy();
    else res.end(JSON.stringify(identity));
  }, { onRetry: () => retries++ });
  assert.equal(requests, 2);
  assert.equal(retries, 1);
});

test('bounds retries when the runtime keeps resetting connections', async (t) => {
  let requests = 0;
  await assert.rejects(probe(t, (req) => { requests++; req.socket.destroy(); }), /failed after 3 attempt/);
  assert.equal(requests, 3);
});

test('uses a fresh timeout for each attempt', async (t) => {
  let requests = 0;
  await probe(t, (_req, res) => {
    if (++requests > 1) res.end(JSON.stringify(identity));
  }, { timeoutMs: 100 });
  assert.equal(requests, 2);
});

for (const mismatch of [{ version: 'other' }, { wrapperPid: 456 }, { preflight: true }]) {
  test(`rejects ${JSON.stringify(mismatch)} immediately, including after transport recovery`, async (t) => {
    let requests = 0;
    await assert.rejects(probe(t, (req, res) => {
      if (++requests === 1) req.socket.destroy();
      else res.end(JSON.stringify({ ...identity, ...mismatch }));
    }), /not owned/);
    assert.equal(requests, 2);
  });
}

for (const failure of ['http', 'json']) {
  test(`does not retry a ${failure} failure`, async (t) => {
    let requests = 0;
    await assert.rejects(probe(t, (_req, res) => {
      requests++;
      res.statusCode = failure === 'http' ? 503 : 200;
      res.end('invalid');
    }), /failed after 1 attempt/);
    assert.equal(requests, 1);
  });
}
