import type BetterSqlite3 from 'better-sqlite3';

/**
 * Retention and storage-reclamation settings for the main WorkLite database.
 *
 * The defaults are the policy a deployment gets without configuring anything: history
 * expires and the reclaimed space goes back to the filesystem on its own, because an
 * installation nobody tunes is the common case and an unbounded replay stream is what
 * turns a working deployment into a full disk. Every window stays operator-configurable
 * for deployments that keep more or less evidence, and a window of 0 disables that pruner.
 */
export type DatabaseMaintenanceSettings = {
  /** Command stdout/stderr older than this keeps only its trailing tail. */
  commandStreamRetentionMs: number;
  commandStreamTailBytes: number;
  /** Replay event streams of terminal Workflow Runs, executor Runs and Chat executions older than this are removed. */
  eventStreamRetentionMs: number;
  /** Upper bound the WAL file is truncated back to whenever a checkpoint resets it. */
  walSizeLimitBytes: number;
  /** Free pages returned to the filesystem per maintenance pass; bounded so one pass cannot hold the write lock for long. */
  incrementalVacuumPages: number;
  maintenanceIntervalMs: number;
  /**
   * Commands, Runs or executions whose expired streams one pass may visit. Bounds the delete:
   * one pass rewrites the streams of this many parents and no more, so it cannot hold the
   * write lock past the busy timeout of the requests running beside it.
   */
  prunedParentsPerPass: number;
  /** Factor applied to both per-pass bounds while a backlog is still being worked off. */
  catchUpFactor: number;
  /** Delay before the next pass while a backlog remains, instead of the full interval. */
  catchUpIntervalMs: number;
  /** Free pages above which the database still counts as holding a backlog. */
  catchUpFreePages: number;
};

const DEFAULTS = {
  commandStreamRetentionDays: 3,
  commandStreamTailKilobytes: 64,
  eventStreamRetentionDays: 14,
  walSizeLimitMegabytes: 64,
  incrementalVacuumPages: 16_384,
  maintenanceIntervalMinutes: 15,
  prunedParentsPerPass: 100,
  catchUpFactor: 4,
  catchUpIntervalMs: 60_000,
  catchUpFreePages: 4_096,
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
  const maintenanceIntervalMs = configuredNumber(environment, 'SQLITE_MAINTENANCE_INTERVAL_MINUTES', DEFAULTS.maintenanceIntervalMinutes, false) * 60_000;
  return {
    commandStreamRetentionMs: configuredNumber(environment, 'COMMAND_STREAM_RETENTION_DAYS', DEFAULTS.commandStreamRetentionDays, true) * 86_400_000,
    commandStreamTailBytes: configuredNumber(environment, 'COMMAND_STREAM_TAIL_KILOBYTES', DEFAULTS.commandStreamTailKilobytes, false) * 1024,
    eventStreamRetentionMs: configuredNumber(environment, 'RUN_EVENT_RETENTION_DAYS', DEFAULTS.eventStreamRetentionDays, true) * 86_400_000,
    walSizeLimitBytes: configuredNumber(environment, 'SQLITE_WAL_SIZE_LIMIT_MEGABYTES', DEFAULTS.walSizeLimitMegabytes, false) * 1024 * 1024,
    incrementalVacuumPages: Math.floor(configuredNumber(environment, 'SQLITE_INCREMENTAL_VACUUM_PAGES', DEFAULTS.incrementalVacuumPages, false)),
    maintenanceIntervalMs,
    prunedParentsPerPass: DEFAULTS.prunedParentsPerPass,
    catchUpFactor: DEFAULTS.catchUpFactor,
    // Catching up may never be slower than the normal cadence an operator configured.
    catchUpIntervalMs: Math.min(DEFAULTS.catchUpIntervalMs, maintenanceIntervalMs),
    catchUpFreePages: DEFAULTS.catchUpFreePages,
  };
}

/**
 * The same windows with the per-pass bounds raised. A deployment that has been running
 * without retention has years of history and gigabytes of free pages behind it: at the
 * normal bounds the backlog is reclaimed slower than new evidence arrives, so passes that
 * still find work run more often and move more per pass until the database is current.
 */
export function catchUpMaintenanceSettings(settings: DatabaseMaintenanceSettings): DatabaseMaintenanceSettings {
  return {
    ...settings,
    prunedParentsPerPass: settings.prunedParentsPerPass * settings.catchUpFactor,
    incrementalVacuumPages: settings.incrementalVacuumPages * settings.catchUpFactor,
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

/** Pages the database holds but no longer uses; what incremental vacuum still has to give back. */
export function freePageCount(client: BetterSqlite3.Database): number {
  const value = client.pragma('freelist_count', { simple: true });
  return typeof value === 'number' ? value : 0;
}

/**
 * Returns free pages to the filesystem. Bounded per pass: a database that has just released
 * hundreds of megabytes would otherwise hold the write lock for the whole rewrite.
 */
export function reclaimFreePages(client: BetterSqlite3.Database, settings: DatabaseMaintenanceSettings): void {
  client.pragma(`incremental_vacuum(${settings.incrementalVacuumPages})`);
}

/**
 * How far each sweep has walked through its parent table.
 *
 * A pass visits a bounded slice of parents rather than everything that has expired, so the
 * slices have to advance: selecting the same oldest parents every time would stall on the
 * ones that have nothing left to prune and never reach the rest of the backlog. The cursor
 * is the id the previous pass stopped at, and an exhausted sweep restarts from the
 * beginning to pick up what has expired since.
 */
const pruneCursors = new Map<string, string>();

function nextParentSlice(client: BetterSqlite3.Database, key: string, query: string, parameters: unknown[], limit: number): { ids: string[]; saturated: boolean } {
  const cursor = pruneCursors.get(key) ?? '';
  const ids = (client.prepare(query).all(...parameters, cursor, limit) as Array<{ id: string }>).map((row) => row.id);
  const saturated = ids.length >= limit;
  pruneCursors.set(key, saturated ? ids[ids.length - 1] : '');
  return { ids, saturated };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

export type PruneResult = { rowsRemoved: number; saturated: boolean };

/**
 * Bounds the command event stream, the largest table in the database. Command, cwd,
 * reservation, lifecycle and exit evidence stay in command_executions and lifecycle
 * events; for executions older than the retention window only the trailing stream
 * output (where results and errors live) is kept.
 *
 * Candidates come from command_executions, which holds one small row per command: a
 * command with an expired event was itself created before the cutoff, so the slice loses
 * nothing, and the tail is then window-summed over that slice alone. Window-summing every
 * stdout row instead was reading the whole gigabyte-scale table on each pass.
 */
export function pruneCommandExecutionEvents(client: BetterSqlite3.Database, settings: DatabaseMaintenanceSettings = databaseMaintenanceSettings()): PruneResult {
  if (settings.commandStreamRetentionMs <= 0) return { rowsRemoved: 0, saturated: false };
  const cutoff = Date.now() - settings.commandStreamRetentionMs;
  const slice = nextParentSlice(
    client,
    'command_execution_events',
    'SELECT id FROM command_executions WHERE created_at < ? AND id > ? ORDER BY id LIMIT ?',
    [cutoff],
    settings.prunedParentsPerPass,
  );
  if (!slice.ids.length) return { rowsRemoved: 0, saturated: slice.saturated };
  const result = client.prepare(`
    DELETE FROM command_execution_events
    WHERE type IN ('stdout', 'stderr')
      AND created_at < ?
      AND sequence IN (
        SELECT sequence FROM (
          SELECT sequence, SUM(LENGTH(data)) OVER (PARTITION BY command_id ORDER BY sequence DESC) AS tail_bytes
          FROM command_execution_events
          WHERE type IN ('stdout', 'stderr')
            AND command_id IN (${placeholders(slice.ids.length)})
        )
        WHERE tail_bytes > ?
      )
  `).run(cutoff, ...slice.ids, settings.commandStreamTailBytes);
  return { rowsRemoved: result.changes, saturated: slice.saturated };
}

type EventStreamTable = { events: string; parentKey: string; parents: string; terminalStatuses: string[]; settledAt: string };

// Replay streams only: each parent row keeps its own input, result, status and child records,
// so dropping the stream costs the streamed text and the activity timeline of an old run,
// never the run itself.
const EVENT_STREAM_TABLES: EventStreamTable[] = [
  { events: 'workflow_run_events', parentKey: 'run_id', parents: 'workflow_runs', terminalStatuses: ['succeeded', 'failed', 'cancelled', 'timed_out'], settledAt: 'COALESCE(finished_at, updated_at, created_at)' },
  { events: 'executor_run_events', parentKey: 'run_id', parents: 'executor_runs', terminalStatuses: ['succeeded', 'failed', 'cancelled'], settledAt: 'COALESCE(finished_at, updated_at, created_at)' },
  { events: 'agent_execution_events', parentKey: 'execution_id', parents: 'agent_executions', terminalStatuses: ['completed', 'failed', 'cancelled'], settledAt: 'COALESCE(updated_at, created_at)' },
];

export function pruneRunEventStreams(client: BetterSqlite3.Database, settings: DatabaseMaintenanceSettings = databaseMaintenanceSettings()): PruneResult {
  if (settings.eventStreamRetentionMs <= 0) return { rowsRemoved: 0, saturated: false };
  const cutoff = Date.now() - settings.eventStreamRetentionMs;
  let rowsRemoved = 0;
  let saturated = false;
  for (const table of EVENT_STREAM_TABLES) {
    const slice = nextParentSlice(
      client,
      table.events,
      `SELECT id FROM ${table.parents} WHERE status IN (${placeholders(table.terminalStatuses.length)}) AND ${table.settledAt} < ? AND id > ? ORDER BY id LIMIT ?`,
      [...table.terminalStatuses, cutoff],
      settings.prunedParentsPerPass,
    );
    saturated = saturated || slice.saturated;
    if (!slice.ids.length) continue;
    const result = client.prepare(`
      DELETE FROM ${table.events}
      WHERE created_at < ?
        AND ${table.parentKey} IN (${placeholders(slice.ids.length)})
    `).run(cutoff, ...slice.ids);
    rowsRemoved += result.changes;
  }
  return { rowsRemoved, saturated };
}

export type DatabaseMaintenanceReport = {
  commandStreamRowsRemoved: number;
  eventStreamRowsRemoved: number;
  walCheckpoint: WalCheckpointResult;
  freePages: number;
  /** History or free pages beyond what one pass at the normal bounds clears: run the next pass sooner. */
  backlog: boolean;
};

/**
 * One maintenance pass: expire history, hand the freed pages back to the filesystem, then
 * fold the WAL into the database and truncate it. Pruning first is what makes the two
 * reclamation steps worth running.
 */
export function runDatabaseMaintenance(client: BetterSqlite3.Database, settings: DatabaseMaintenanceSettings = databaseMaintenanceSettings()): DatabaseMaintenanceReport {
  const commandStreams = pruneCommandExecutionEvents(client, settings);
  const eventStreams = pruneRunEventStreams(client, settings);
  reclaimFreePages(client, settings);
  const walCheckpoint = checkpointWal(client);
  const freePages = freePageCount(client);
  const rowsRemoved = commandStreams.rowsRemoved + eventStreams.rowsRemoved;
  return {
    commandStreamRowsRemoved: commandStreams.rowsRemoved,
    eventStreamRowsRemoved: eventStreams.rowsRemoved,
    walCheckpoint,
    freePages,
    // Still removing rows with parents left in the sweep, or holding more free pages than a
    // pass gives back, both mean the next pass has work; a caught-up database reports neither.
    backlog: freePages > settings.catchUpFreePages || (rowsRemoved > 0 && (commandStreams.saturated || eventStreams.saturated)),
  };
}
