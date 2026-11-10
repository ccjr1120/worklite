import type BetterSqlite3 from 'better-sqlite3';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type DatabaseMaintenanceSettings = {
  commandHistoryRetentionMs: number;
  commandStreamRetentionMs: number;
  commandStreamTailBytes: number;
  eventStreamRetentionMs: number;
  toolPackageRetentionMs: number;
  apiLogRetentionMs: number;
  gatewayLogRetentionMs: number;
  gatewayStatsRetentionMs: number;
  walSizeLimitBytes: number;
  incrementalVacuumPages: number;
  maintenanceIntervalMs: number;
  rowsPerBatch: number;
  prunedParentsPerPass: number;
  catchUpFactor: number;
  catchUpIntervalMs: number;
  catchUpFreePages: number;
};
export type DatabaseMaintenanceReport = {
  removed: number;
  changed: number;
  freePages: number;
  backlog: boolean;
  checkpoint: { busy: number; log: number; checkpointed: number };
};
export function maintenanceScriptPath(): string {
  const path = ['scripts/sqlite-maintenance.cjs', '../../scripts/sqlite-maintenance.cjs']
    .map((path) => resolve(process.cwd(), path))
    .find(existsSync);
  if (!path) throw new Error('SQLite maintenance worker script could not be located.');
  return path;
}
const requireMaintenance = () =>
  createRequire(resolve(process.cwd(), 'package.json'))(maintenanceScriptPath()) as {
    settings(environment?: Record<string, string | undefined>): DatabaseMaintenanceSettings;
    pass(
      client: BetterSqlite3.Database,
      settings: DatabaseMaintenanceSettings,
    ): Promise<DatabaseMaintenanceReport>;
    pruneCommand(
      client: BetterSqlite3.Database,
      settings: DatabaseMaintenanceSettings,
      now: number,
    ): { removed: number; backlog: boolean };
    pruneEvents(
      client: BetterSqlite3.Database,
      settings: DatabaseMaintenanceSettings,
      now: number,
    ): { removed: number; backlog: boolean };
  };
export function databaseMaintenanceSettings(
  environment: Record<string, string | undefined> = process.env,
): DatabaseMaintenanceSettings {
  return requireMaintenance().settings(environment);
}
export function applyWalSizeLimit(
  client: BetterSqlite3.Database,
  settings: DatabaseMaintenanceSettings,
): void {
  client.pragma(`journal_size_limit = ${settings.walSizeLimitBytes}`);
}
export function freePageCount(client: BetterSqlite3.Database): number {
  return client.pragma('freelist_count', { simple: true }) as number;
}
export function pruneCommandExecutionEvents(
  client: BetterSqlite3.Database,
  settings = databaseMaintenanceSettings(),
) {
  const result = requireMaintenance().pruneCommand(client, settings, Date.now());
  return { rowsRemoved: result.removed, saturated: result.backlog };
}
export function pruneRunEventStreams(
  client: BetterSqlite3.Database,
  settings = databaseMaintenanceSettings(),
) {
  const result = requireMaintenance().pruneEvents(client, settings, Date.now());
  return { rowsRemoved: result.removed, saturated: result.backlog };
}
/** Administrative/testing API. Serving processes call this in a worker, never their event loop. */
export function runDatabaseMaintenance(
  client: BetterSqlite3.Database,
  settings = databaseMaintenanceSettings(),
) {
  return requireMaintenance().pass(client, settings);
}
