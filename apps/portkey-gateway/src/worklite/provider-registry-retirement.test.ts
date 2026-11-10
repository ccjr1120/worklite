import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createProvider, getProvider, listProviders, prepareGatewayDatabase } from './provider-registry';

const originalPath = process.env.PORTKEY_GATEWAY_DB_PATH;
let directory: string;
let path: string;
beforeAll(() => {
  mkdirSync(join(process.cwd(), '.data'), { recursive: true });
  directory = mkdtempSync(join(process.cwd(), '.data/gateway-retirement-'));
  path = join(directory, 'gateway.db');
  const db = new BetterSqlite3(path);
  db.exec(`CREATE TABLE gateway_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL, base_url TEXT, models TEXT DEFAULT '[]', api_key TEXT, headers TEXT, status TEXT, masked_key TEXT, updated_at INTEGER); INSERT INTO gateway_providers (id, name, protocol) VALUES ('legacy-id', 'legacy-name', 'codex/responses')`);
  db.close();
  process.env.PORTKEY_GATEWAY_DB_PATH = path;
  prepareGatewayDatabase();
});
afterAll(() => {
  if (originalPath === undefined) delete process.env.PORTKEY_GATEWAY_DB_PATH;
  else process.env.PORTKEY_GATEWAY_DB_PATH = originalPath;
  rmSync(directory, { recursive: true, force: true });
});

describe('Codex Provider coexistence', () => {
  it('keeps existing Codex Providers and stops recording them as retired', async () => {
    expect(await listProviders()).toEqual([expect.objectContaining({ id: 'legacy-id', protocol: 'codex/responses' })]);
    expect(await getProvider('legacy-id')).toMatchObject({ name: 'legacy-name', protocol: 'codex/responses' });
    const db = new BetterSqlite3(path, { readonly: true });
    try { expect(db.prepare('SELECT * FROM retired_codex_providers').all()).toEqual([]); }
    finally { db.close(); }
  });

  it('allows creation of another Codex Provider without removing the existing record', async () => {
    const created = await createProvider({ name: 'new-codex', protocol: 'codex/responses', baseURL: 'https://example.com', models: ['gpt-test'] });
    expect(created).toMatchObject({ protocol: 'codex/responses', apiKey: '', models: ['gpt-test'] });
    expect(await getProvider(created.id)).toMatchObject({ protocol: 'codex/responses' });
    expect(await listProviders()).toHaveLength(2);
  });
});
