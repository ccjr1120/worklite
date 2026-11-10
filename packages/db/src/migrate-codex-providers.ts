import BetterSqlite3 from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { packJson, unpackJson } from './packed-json';

export type RetiredCodexProvider = { id: string; name: string };
const tableExists = (db: BetterSqlite3.Database, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/** Read identities only. Active Providers coexist with the engine and are never retired here. */
export function codexProviderMigrationState(db: BetterSqlite3.Database, gatewayPath?: string): { retired: RetiredCodexProvider[]; active: RetiredCodexProvider[] } {
  const retired: RetiredCodexProvider[] = [{ id: 'codex-provider', name: 'codex' }];
  const active = tableExists(db, 'model_providers') ? db.prepare("SELECT id, name FROM model_providers WHERE protocol = 'codex/responses'").all() as RetiredCodexProvider[] : [];
  if (tableExists(db, 'retired_codex_providers')) retired.push(...db.prepare('SELECT id, name FROM retired_codex_providers').all() as RetiredCodexProvider[]);
  const path = gatewayPath ?? (process.env.PORTKEY_GATEWAY_DB_PATH ? resolve(process.cwd(), process.env.PORTKEY_GATEWAY_DB_PATH) : db.name !== ':memory:' ? join(dirname(db.name), 'worklite-gateway.db') : undefined);
  if (path && existsSync(path)) {
    const gateway = new BetterSqlite3(path, { readonly: true });
    try {
      if (tableExists(gateway, 'gateway_providers')) active.push(...gateway.prepare("SELECT id, name FROM gateway_providers WHERE protocol = 'codex/responses'").all() as RetiredCodexProvider[]);
      if (tableExists(gateway, 'retired_codex_providers')) retired.push(...gateway.prepare('SELECT id, name FROM retired_codex_providers').all() as RetiredCodexProvider[]);
    } finally { gateway.close(); }
  }
  return { retired: [...new Map(retired.filter((provider) => !active.some((live) => live.id === provider.id)).map((provider) => [provider.id, provider])).values()], active };
}

/** Finish migrations of already retired identities without deleting live Providers or undoing completed migrations. */
export function migrateCodexProviders(db: BetterSqlite3.Database, gatewayPath?: string): void {
  const state = codexProviderMigrationState(db, gatewayPath);
  const activeNames = state.active.map((provider) => provider.name);
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS retired_codex_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE IF NOT EXISTS codex_provider_runtime_migrations (provider_id TEXT PRIMARY KEY)');
    const save = db.prepare('INSERT OR IGNORE INTO retired_codex_providers (id, name) VALUES (?, ?)');
    for (const provider of state.retired) save.run(provider.id, provider.name);
    const migrated = new Set((db.prepare('SELECT provider_id FROM codex_provider_runtime_migrations').all() as Array<{ provider_id: string }>).map((row) => row.provider_id));
    const retired = state.retired.filter((provider) => !migrated.has(provider.id));
    if (!retired.length) return;
    for (const table of ['agents', 'agent_versions']) {
      if (!tableExists(db, table)) continue;
      const rows = db.prepare(`SELECT id, provider_id, model, model_parameters, runtime, ${table === 'agents' ? 'collaboration' : 'NULL AS collaboration'} FROM ${table}`).all() as Array<{ id: string; provider_id: string | null; model: string; model_parameters: string | null; runtime: string; collaboration: string | null }>;
      for (const row of rows) {
        const config = { providerId: row.provider_id, model: row.model, modelParameters: row.model_parameters ? JSON.parse(row.model_parameters) : null, runtime: JSON.parse(row.runtime), collaboration: row.collaboration ? JSON.parse(row.collaboration) : null };
        if (migrateCodexConfiguration(config, retired, activeNames)) {
          db.prepare(`UPDATE ${table} SET provider_id = ?, model = ?, runtime = ?, model_parameters = ? WHERE id = ?`).run(config.providerId, config.model, JSON.stringify(config.runtime), config.modelParameters ? JSON.stringify(config.modelParameters) : null, row.id);
          if (table === 'agents') db.prepare('UPDATE agents SET collaboration = ? WHERE id = ?').run(config.collaboration ? JSON.stringify(config.collaboration) : null, row.id);
        }
      }
    }
    for (const row of db.prepare('SELECT workspace_id, revision, provider_id, model, model_parameters, runtime FROM chat_bot_configurations').all() as Array<{ workspace_id: string; revision: number; provider_id: string | null; model: string; model_parameters: string | null; runtime: string }>) {
      const config = { providerId: row.provider_id, model: row.model, modelParameters: row.model_parameters ? JSON.parse(row.model_parameters) : null, runtime: JSON.parse(row.runtime) };
      if (migrateCodexConfiguration(config, retired, activeNames)) db.prepare('UPDATE chat_bot_configurations SET provider_id = NULL, model = ?, model_parameters = ?, runtime = ? WHERE workspace_id = ? AND revision = ?').run(config.model, config.modelParameters ? JSON.stringify(config.modelParameters) : null, JSON.stringify(config.runtime), row.workspace_id, row.revision);
    }
    for (const row of db.prepare('SELECT id, capability_snapshot FROM agent_executions WHERE capability_snapshot IS NOT NULL').all() as Array<{ id: string; capability_snapshot: string }>) {
      const snapshot = unpackJson<{ agent?: Record<string, unknown> } | null>(row.capability_snapshot);
      if (snapshot?.agent && migrateCodexConfiguration(snapshot.agent, retired, activeNames)) db.prepare('UPDATE agent_executions SET capability_snapshot = ? WHERE id = ?').run(packJson(snapshot), row.id);
    }
    // Captured native runtime launches may contain a retired public model name as well.
    for (const row of db.prepare('SELECT id, launch FROM agent_runtime_sessions').all() as Array<{ id: string; launch: string }>) {
      const launch = JSON.parse(row.launch);
      if (launch.executor !== 'codex' || typeof launch.model !== 'string') continue;
      const model = bareModel(launch.model, retired.filter((provider) => !activeNames.includes(provider.name)));
      if (model !== launch.model) db.prepare('UPDATE agent_runtime_sessions SET launch = ?, external_session_id = NULL WHERE id = ?').run(JSON.stringify({ ...launch, model }), row.id);
    }
    for (const provider of retired) db.prepare('INSERT INTO codex_provider_runtime_migrations (provider_id) VALUES (?)').run(provider.id);
  })();
}

function bareModel(model: string, retired: RetiredCodexProvider[]): string {
  const provider = retired.find((provider) => model.startsWith(`${provider.name}/`));
  return provider ? model.slice(provider.name.length + 1) : model;
}

/** Also repairs stale file catalogs; a reused public model name belongs to the active Provider. */
export function migrateCodexConfiguration(config: Record<string, unknown>, retired: RetiredCodexProvider[], activeNames: readonly string[] = []): boolean {
  const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const collaboration = record(config.collaboration);
  const runtime = record(config.runtime);
  const modelParameters = record(collaboration?.modelParameters);
  const publicModels: string[] = Array.isArray(collaboration?.publicModels) ? collaboration.publicModels.filter((model): model is string => typeof model === 'string') : [];
  const provider = retired.some((provider) => config.providerId === provider.id);
  const retiredNames = retired.filter((provider) => !activeNames.includes(provider.name));
  const publicModel = publicModels.find((model) => bareModel(model, retiredNames) !== model);
  const runtimeModel = typeof config.model === 'string' && bareModel(config.model, retiredNames) !== config.model;
  if (!provider && !publicModel && !runtimeModel) return false;
  config.providerId = null;
  const selectedModel = provider ? typeof config.model === 'string' ? config.model : '' : publicModel || (typeof config.model === 'string' ? config.model : '');
  config.model = bareModel(selectedModel, retired);
  const parameters = record(!provider && publicModel ? modelParameters?.[selectedModel] ?? config.modelParameters : config.modelParameters);
  if (parameters) config.modelParameters = Object.fromEntries(Object.entries(parameters).filter(([key]) => ['reasoningEffort', 'serviceTier'].includes(key)));
  config.runtime = { kind: 'codex', projectDirectory: runtime?.projectDirectory ?? '', approvalPolicy: runtime?.approvalPolicy ?? 'auto' };
  if (collaboration) {
    config.collaboration = { ...collaboration, publicModels: [], ...(modelParameters ? { modelParameters: Object.fromEntries(Object.entries(modelParameters).filter(([model]) => bareModel(model, retiredNames) === model)) } : {}) };
  }
  return true;
}
