import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const script = resolve('docs/qcoder-local-project-search/search-local-projects.mjs');

it('runs the Agent-owned command script against the existing index and checks paths without a capability registry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worklite-private-lookup-'));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ results: [], approximate: [{ absolutePath: directory }], partial: true, stale: true, timedOut: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const env = { ...process.env, WORKLITE_API_URL: `http://127.0.0.1:${address.port}`, WORKLITE_TOOL_INPUT_BASE64: Buffer.from(JSON.stringify({ input: { query: directory, refresh: true } })).toString('base64') };
    const { stdout } = await execute(process.execPath, [script], { env });
    expect(JSON.parse(stdout)).toMatchObject({ lookupStatus: 'not_indexed', requestedDirectory: { absolutePath: directory, directoryStatus: 'exists' }, approximate: [{ directoryStatus: 'exists' }], partial: true, stale: true });
    expect(requests[0]).toContain('/api/local-projects/search?');
    expect(requests[0]).toContain('refresh=true');
    await expect(execute(process.execPath, [script], { env: { ...env, WORKLITE_TOOL_INPUT_BASE64: Buffer.from(JSON.stringify({ input: { query: directory, limit: 0 } })).toString('base64') } })).rejects.toThrow('limit must be');
    expect(requests).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
