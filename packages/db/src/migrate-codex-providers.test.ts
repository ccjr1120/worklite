import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, agentVersions, chatConfigurations, agentExecutions, modelProviders } from './schema';
import { createDb, initializeDatabase, type Database } from './client';
import { migrateCodexConfiguration, migrateCodexProviders } from './migrate-codex-providers';

let db: Database;
afterEach(() => db?.$client.close());

describe('retired Codex Provider migration', () => {
  it('migrates configured Agents, Chat revisions and packed execution snapshots idempotently', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    const workspaceId = 'workspace_personal';
    db.$client.prepare("INSERT INTO retired_codex_providers(id, name) VALUES ('old', 'old-name')").run();
    db.insert(agents).values({ id: 'old-agent', workspaceId, name: 'Agent', responsibility: '', providerId: 'old', model: 'gpt-test', modelParameters: { reasoningEffort: 'high', requestBody: { temperature: 0.3 } } }).run();
    db.insert(agentVersions).values({ id: 'old-version', workspaceId, agentId: 'old-agent', version: 1, name: 'Agent', responsibility: '', systemPrompt: '', providerId: 'old', model: 'gpt-test' }).run();
    db.update(agents).set({ providerId: 'old', model: 'gpt-chat' }).where(eq(agents.id, 'agt_system_helper_chat')).run();
    db.update(chatConfigurations).set({ providerId: 'old', model: 'gpt-chat' }).run();
    db.insert(agentExecutions).values({ id: 'history', workspaceId, agentId: 'agt_system_helper_chat', capabilitySnapshot: { revision: 1, agent: { id: 'agt_system_helper_chat', providerId: 'old', model: 'gpt-chat', systemPrompt: 'old'.repeat(2000) }, skills: [], mcpServers: [] } }).run();
    migrateCodexProviders(db.$client);
    migrateCodexProviders(db.$client);
    expect(db.select().from(modelProviders).all().map((provider) => provider.id)).not.toContain('old');
    expect(db.select().from(agents).where(eq(agents.id, 'old-agent')).get()).toMatchObject({ providerId: null, model: 'gpt-test', modelParameters: { reasoningEffort: 'high' }, runtime: { kind: 'codex', projectDirectory: '' } });
    expect(db.select().from(agentVersions).get()).toMatchObject({ providerId: null, runtime: { kind: 'codex' } });
    expect(db.select().from(chatConfigurations).get()).toMatchObject({ providerId: null, model: 'gpt-chat', runtime: { kind: 'codex' } });
    expect(db.select().from(agentExecutions).get()?.capabilitySnapshot?.agent).toMatchObject({ providerId: null, model: 'gpt-chat', runtime: { kind: 'codex' } });
  });

  it('migrates custom provider ids even when the Gateway has already removed their records', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    db.update(agents).set({ providerId: 'archived-id', model: 'gpt-test' }).where(eq(agents.id, 'agt_system_helper_chat')).run();
    const directory = mkdtempSync(join(process.cwd(), '.migration-test-'));
    const path = join(directory, 'gateway.db');
    const gateway = new BetterSqlite3(path);
    try {
      gateway.exec("CREATE TABLE retired_codex_providers(id TEXT PRIMARY KEY, name TEXT); INSERT INTO retired_codex_providers VALUES ('archived-id', 'custom-codex')");
      migrateCodexProviders(db.$client, path);
      expect(db.select().from(agents).where(eq(agents.id, 'agt_system_helper_chat')).get()).toMatchObject({ providerId: null, model: 'gpt-test', runtime: { kind: 'codex' } });
    } finally { gateway.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('rewrites file configuration public models without retaining a retired provider prefix', () => {
    const config = { providerId: null, model: '', runtime: { kind: 'native' }, collaboration: { publicModels: ['retired/gpt-test'], modelParameters: { 'retired/gpt-test': { reasoningEffort: 'high' } } } };
    expect(migrateCodexConfiguration(config, [{ id: 'old', name: 'retired' }])).toBe(true);
    expect(config).toMatchObject({ providerId: null, model: 'gpt-test', runtime: { kind: 'codex' }, collaboration: { publicModels: [], modelParameters: {} } });
    expect(migrateCodexConfiguration(config, [{ id: 'old', name: 'retired' }])).toBe(false);
  });
  it('preserves active local Codex Providers and native selections across repeated initialization', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    db.insert(modelProviders).values({ id: 'active', workspaceId: 'workspace_personal', name: 'active-codex', protocol: 'codex/responses', models: ['gpt-test'] }).run();
    db.$client.prepare("INSERT INTO retired_codex_providers VALUES ('active', 'active-codex')").run();
    db.update(agents).set({ providerId: 'active', model: 'gpt-test', runtime: { kind: 'native' } }).where(eq(agents.id, 'agt_system_helper_chat')).run();
    db.update(chatConfigurations).set({ providerId: 'active', model: 'gpt-test', runtime: { kind: 'native' } }).run();
    await initializeDatabase(db);
    migrateCodexProviders(db.$client);
    expect(db.select().from(modelProviders).where(eq(modelProviders.id, 'active')).get()).toMatchObject({ protocol: 'codex/responses', models: ['gpt-test'] });
    expect(db.select().from(agents).where(eq(agents.id, 'agt_system_helper_chat')).get()).toMatchObject({ providerId: 'active', runtime: { kind: 'native' } });
    expect(db.select().from(chatConfigurations).get()).toMatchObject({ providerId: 'active', runtime: { kind: 'native' } });
  });

  it('preserves a live Gateway Provider whose name reuses a retired identity without rolling back engine configurations', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    const directory = mkdtempSync(join(process.cwd(), '.migration-test-'));
    const path = join(directory, 'gateway.db');
    const gateway = new BetterSqlite3(path);
    try {
      gateway.exec("CREATE TABLE gateway_providers(id TEXT PRIMARY KEY, name TEXT, protocol TEXT); INSERT INTO gateway_providers VALUES ('live', 'codex', 'codex/responses'); CREATE TABLE retired_codex_providers(id TEXT PRIMARY KEY, name TEXT); INSERT INTO retired_codex_providers VALUES ('old-id', 'codex')");
      db.insert(agents).values({ id: 'native-proxy', workspaceId: 'workspace_personal', name: 'Proxy', responsibility: '', model: 'codex/gpt-test', runtime: { kind: 'native' }, collaboration: { subAgentIds: [], capabilities: [], publicModels: ['codex/gpt-test'] } }).run();
      db.insert(agents).values({ id: 'already-migrated', workspaceId: 'workspace_personal', name: 'Engine', responsibility: '', model: 'gpt-test', runtime: { kind: 'codex', projectDirectory: '' } }).run();
      db.insert(agents).values({ id: 'stale-reference', workspaceId: 'workspace_personal', name: 'Stale', responsibility: '', providerId: 'old-id', model: 'gpt-test' }).run();
      migrateCodexProviders(db.$client, path);
      migrateCodexProviders(db.$client, path);
      expect(db.select().from(agents).where(eq(agents.id, 'native-proxy')).get()).toMatchObject({ model: 'codex/gpt-test', runtime: { kind: 'native' }, collaboration: { publicModels: ['codex/gpt-test'] } });
      expect(db.select().from(agents).where(eq(agents.id, 'already-migrated')).get()).toMatchObject({ model: 'gpt-test', runtime: { kind: 'codex' } });
      expect(db.select().from(agents).where(eq(agents.id, 'stale-reference')).get()).toMatchObject({ providerId: null, runtime: { kind: 'codex' } });
      expect(gateway.prepare('SELECT id FROM gateway_providers').all()).toEqual([{ id: 'live' }]);
    } finally { gateway.close(); rmSync(directory, { recursive: true, force: true }); }
  });

});
