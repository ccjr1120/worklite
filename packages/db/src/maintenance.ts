import type BetterSqlite3 from 'better-sqlite3';

/**
 * Retention and storage-reclamation settings for the main WorkLite database.
 *
 * Every window is operator-configurable because retention is a deployment policy, not a
 * product rule: the defaults keep the behaviour the product documents, and a deployment
 * that produces more evidence than its disk can hold tightens them without a code change.
 * A window of 0 disables that pruner.
 */
export type DatabaseMaintenanceSettings = {
  /** Command stdout/stderr older than this keeps only its trailing tail. */
  commandStreamRetentionMs: number;
  commandStreamTailBytes: number;
  /** Replay event streams of terminal Workflow Runs, Team Runs and Chat executions older than this are removed. Disabled by default. */
  eventStreamRetentionMs: number;
  /** Upper bound the WAL file is truncated back to whenever a checkpoint resets it. */
  walSizeLimitBytes: number;
  /** Free pages returned to the filesystem per maintenance pass; bounded so one pass cannot hold the write lock for long. */
  incrementalVacuumPages: number;
  maintenanceIntervalMs: number;
};

const DEFAULTS = {
  commandStreamRetentionDays: 7,
  commandStreamTailKilobytes: 64,
  eventStreamRetentionDays: 0,
  walSizeLimitMegabytes: 64,
  incrementalVacuumPages: 16_384,
  maintenanceIntervalMinutes: 15,
} as const;

type Environment = Record<string, string | undefined>;

function configuredNumber(environment: Environment, key: string, fallback: number, allowZero: boolean): number {
  const raw = environment[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) return fallback;
  return value;
}

export function databaseMaintenanceSettings(environment: Environment = process.env): DatabaseMaintenanceSettings {
  return {
    commandStreamRetentionMs: configuredNumber(environment, 'COMMAND_STREAM_RETENTION_DAYS', DEFAULTS.commandStreamRetentionDays, true) * 86_400_000,
    commandStreamTailBytes: configuredNumber(environment, 'COMMAND_STREAM_TAIL_KILOBYTES', DEFAULTS.commandStreamTailKilobytes, false) * 1024,
    eventStreamRetentionMs: configuredNumber(environment, 'RUN_EVENT_RETENTION_DAYS', DEFAULTS.eventStreamRetentionDays, true) * 86_400_000,
    walSizeLimitBytes: configuredNumber(environment, 'SQLITE_WAL_SIZE_LIMIT_MEGABYTES', DEFAULTS.walSizeLimitMegabytes, false) * 1024 * 1024,
    incrementalVacuumPages: Math.floor(configuredNumber(environment, 'SQLITE_INCREMENTAL_VACUUM_PAGES', DEFAULTS.incrementalVacuumPages, false)),
    maintenanceIntervalMs: configuredNumber(environment, 'SQLITE_MAINTENANCE_INTERVAL_MINUTES', DEFAULTS.maintenanceIntervalMinutes, false) * 60_000,
  };
}

/**
 * Caps the WAL file. Without a size limit the journal only shrinks when SQLite happens to
 * reset it, and under the continuous event-stream write load it never does: a passive
 * checkpoint backfills frames into the database but cannot restart a WAL that a reader is
 * still attached to, so the file grows without bound while its contents are already durable.
 */
export function applyWalSizeLimit(client: BetterSqlite3.Database, settings: DatabaseMaintenanceSettings): void {
  client.pragma(`journal_size_limit = ${settings.walSizeLimitBytes}`);
}

export type WalCheckpointResult = { busy: boolean; walPages: number; checkpointedPages: number };

/**
 * Forces the WAL back to the size limit. TRUNCATE waits for the readers a passive checkpoint
 * would give up on, which is why it is scheduled on a timer rather than attached to a commit;
 * a busy result is normal and simply leaves the work for the next pass.
 */
export function checkpointWal(client: BetterSqlite3.Database): WalCheckpointResult {
  const [row] = client.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number; log: number; checkpointed: number }>;
  return { busy: (row?.busy ?? 0) !== 0, walPages: row?.log ?? 0, checkpointedPages: row?.checkpointed ?? 0 };
}

/**
 * Returns free pages to the filesystem. Bounded per pass: a database that has just released
 * hundreds of megabytes would otherwise hold the write lock for the whole rewrite.
 */
export function reclaimFreePages(client: BetterSqlite3.Database, settings: DatabaseMaintenanceSettings): void {
  client.pragma(`incremental_vacuum(${settings.incrementalVacuumPages})`);
}

/**
 * Bounds the command event stream, the largest table in the database. Command, cwd,
 * reservation, lifecycle and exit evidence stay in command_executions and lifecycle
 * events; for executions older than the retention window only the trailing stream
 * output (where results and errors live) is kept.
 *
 * The tail is computed only over the commands that actually have expired rows. Scanning
 * every stdout row to window-sum it was reading the whole gigabyte-scale table on each pass.
 */
export function pruneCommandExecutionEvents(client: BetterSqlite3.Database, settings: DatabaseMaintenanceSettings = databaseMaintenanceSettings()): number {
  if (settings.commandStreamRetentionMs <= 0) return 0;
  const cutoff = Date.now() - settings.commandStreamRetentionMs;
  const result = client.prepare(`
    DELETE FROM command_execution_events
    WHERE type IN ('stdout', 'stderr')
      AND created_at < ?
      AND sequence IN (
        SELECT sequence FROM (
          SELECT sequence, SUM(LENGTH(data)) OVER (PARTITION BY command_id ORDER BY sequence DESC) AS tail_bytes
          FROM command_execution_events
          WHERE type IN ('stdout', 'stderr')
            AND command_id IN (
              SELECT DISTINCT command_id FROM command_execution_events
              WHERE type IN ('stdout', 'stderr') AND created_at < ?
            )
        )
        WHERE tail_bytes > ?
      )
  `).run(cutoff, cutoff, settings.commandStreamTailBytes);
  return result.changes;
}

type EventStreamTable = { events: string; parentKey: string; parents: string; terminalStatuses: string[]; settledAt: string };

// Replay streams only: each parent row keeps its own input, result, status and child records,
// so dropping the stream costs the streamed text and the activity timeline of an old run,
// never the run itself.
const EVENT_STREAM_TABLES: EventStreamTable[] = [
  { events: 'workflow_run_events', parentKey: 'run_id', parents: 'workflow_runs', terminalStatuses: ['succeeded', 'failed', 'cancelled', 'timed_out'], settledAt: 'COALESCE(finished_at, updated_at, created_at)' },
  { events: 'agent_team_run_events', parentKey: 'run_id', parents: 'agent_team_runs', terminalStatuses: ['succeeded', 'failed', 'cancelled'], settledAt: 'COALESCE(finished_at, updated_at, created_at)' },
  { events: 'agent_execution_events', parentKey: 'execution_id', parents: 'agent_executions', terminalStatuses: ['completed', 'failed', 'cancelled'], settledAt: 'COALESCE(updated_at, created_at)' },
];

export function pruneRunEventStreams(client: BetterSqlite3.Database, settings: DatabaseMaintenanceSettings = databaseMaintenanceSettings()): number {
  if (settings.eventStreamRetentionMs <= 0) return 0;
  const cutoff = Date.now() - settings.eventStreamRetentionMs;
  let removed = 0;
  for (const table of EVENT_STREAM_TABLES) {
    const placeholders = table.terminalStatuses.map(() => '?').join(', ');
    const result = client.prepare(`
      DELETE FROM ${table.events}
      WHERE created_at < ?
        AND ${table.parentKey} IN (
          SELECT id FROM ${table.parents}
          WHERE status IN (${placeholders}) AND ${table.settledAt} < ?
        )
    `).run(cutoff, ...table.terminalStatuses, cutoff);
    removed += result.changes;
  }
  return removed;
}

export type DatabaseMaintenanceReport = {
  commandStreamRowsRemoved: number;
  eventStreamRowsRemoved: number;
  walCheckpoint: WalCheckpointResult;
};

/**
 * One maintenance pass: expire history, hand the freed pages back to the filesystem, then
 * fold the WAL into the database and truncate it. Pruning first is what makes the two
 * reclamation steps worth running.
 */
export function runDatabaseMaintenance(client: BetterSqlite3.Database, settings: DatabaseMaintenanceSettings = databaseMaintenanceSettings()): DatabaseMaintenanceReport {
  const commandStreamRowsRemoved = pruneCommandExecutionEvents(client, settings);
  const eventStreamRowsRemoved = pruneRunEventStreams(client, settings);
  reclaimFreePages(client, settings);
  return { commandStreamRowsRemoved, eventStreamRowsRemoved, walCheckpoint: checkpointWal(client) };
}
