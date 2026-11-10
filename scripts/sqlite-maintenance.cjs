/* Shared by the API worker, Gateway worker and the explicit maintenance CLI.
 * No HTTP handlers or main-thread timers perform these SQLite operations. */
const { createRequire } = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');
const { resolve } = require('node:path');
const { deflateSync } = require('node:zlib');
const Database = createRequire(resolve(__dirname, '../packages/db/package.json'))('better-sqlite3');
const DAY = 86400000;
const pause = () => new Promise((done) => setTimeout(done, 5));
function bound(env, key, fallback, zero = false) {
  const value = env[key]?.trim();
  const n = value ? Number(value) : NaN;
  return Number.isFinite(n) && (zero ? n >= 0 : n > 0) ? n : fallback;
}
function settings(env = process.env) {
  return {
    commandHistoryRetentionMs: bound(env, 'COMMAND_HISTORY_RETENTION_DAYS', 30, true) * DAY,
    commandStreamRetentionMs: bound(env, 'COMMAND_STREAM_RETENTION_DAYS', 3, true) * DAY,
    commandStreamTailBytes: bound(env, 'COMMAND_STREAM_TAIL_KILOBYTES', 16) * 1024,
    eventStreamRetentionMs: bound(env, 'RUN_EVENT_RETENTION_DAYS', 7, true) * DAY,
    toolPackageRetentionMs: bound(env, 'TOOL_PACKAGE_RETENTION_DAYS', 7, true) * DAY,
    apiLogRetentionMs: bound(env, 'API_REQUEST_LOG_RETENTION_DAYS', 1, true) * DAY,
    gatewayLogRetentionMs: bound(env, 'GATEWAY_REQUEST_LOG_RETENTION_HOURS', 12, true) * 3600000,
    gatewayStatsRetentionMs: bound(env, 'GATEWAY_STATS_RETENTION_DAYS', 90, true) * DAY,
    maintenanceIntervalMs: bound(env, 'SQLITE_MAINTENANCE_INTERVAL_MINUTES', 15) * 60000,
    catchUpIntervalMs: bound(env, 'SQLITE_MAINTENANCE_CATCH_UP_SECONDS', 5) * 1000,
    walSizeLimitBytes: bound(env, 'SQLITE_WAL_SIZE_LIMIT_MEGABYTES', 64) * 1024 * 1024,
    incrementalVacuumPages: Math.max(
      1,
      Math.floor(bound(env, 'SQLITE_INCREMENTAL_VACUUM_PAGES', 1024)),
    ),
    rowsPerBatch: Math.max(1, Math.floor(bound(env, 'SQLITE_MAINTENANCE_BATCH_ROWS', 500))),
    prunedParentsPerPass: 100,
    catchUpFactor: 1,
    catchUpFreePages: 0,
  };
}
const cursors = new WeakMap();
function cursorState(db) {
  if (!cursors.has(db)) cursors.set(db, {});
  return cursors.get(db);
}
function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function pack(value) {
  if (typeof value !== 'string' || value.length < 2048 || value.startsWith('worklite:z1:'))
    return value;
  const packed = 'worklite:z1:' + deflateSync(value).toString('base64');
  return packed.length < value.length ? packed : value;
}
function pruneCommand(db, s, now) {
  if (!s.commandStreamRetentionMs) return { removed: 0, backlog: false };
  const state = cursorState(db);
  const rows = db
    .prepare(
      "SELECT id FROM command_executions WHERE id > ? AND created_at < ? AND status IN ('succeeded','failed','cancelled') ORDER BY id LIMIT ?",
    )
    .all(state.commands ?? '', now - s.commandStreamRetentionMs, s.prunedParentsPerPass);
  let removed = 0;
  for (const { id } of rows) {
    const stream = db
      .prepare(
        "SELECT sequence, data, created_at FROM command_execution_events WHERE command_id = ? AND type IN ('stdout','stderr') ORDER BY sequence DESC",
      )
      .iterate(id);
    let bytes = 0,
      boundary;
    for (const row of stream) {
      const length = Buffer.byteLength(row.data);
      if (bytes + length >= s.commandStreamTailBytes) {
        boundary = { ...row, remaining: Math.max(0, s.commandStreamTailBytes - bytes) };
        break;
      }
      bytes += length;
    }
    if (boundary) {
      const changes = db.transaction(() => {
        const count = db
          .prepare(
            "DELETE FROM command_execution_events WHERE sequence IN (SELECT sequence FROM command_execution_events WHERE command_id=? AND type IN ('stdout','stderr') AND created_at < ? AND sequence < ? LIMIT ?)",
          )
          .run(id, now - s.commandStreamRetentionMs, boundary.sequence, s.rowsPerBatch).changes;
        if (
          boundary.created_at < now - s.commandStreamRetentionMs &&
          Buffer.byteLength(boundary.data) > boundary.remaining
        ) {
          const buffer = Buffer.from(boundary.data);
          let start = buffer.length - boundary.remaining;
          while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
          db.prepare('UPDATE command_execution_events SET data=? WHERE sequence=?').run(
            buffer.subarray(start).toString(),
            boundary.sequence,
          );
        }
        return count;
      })();
      removed += changes;
      if (changes >= s.rowsPerBatch) return { removed, backlog: true }; // revisit this parent, with a bounded write lock
    }
    state.commands = id;
  }
  const backlog = rows.length >= s.prunedParentsPerPass;
  if (!backlog) state.commands = '';
  return { removed, backlog };
}
function pruneCommandHistory(db, s, now) {
  if (!s.commandHistoryRetentionMs) return { removed: 0, backlog: false };
  const rows = db
    .prepare(
      "SELECT id FROM command_executions WHERE created_at < ? AND status IN ('succeeded','failed','cancelled') ORDER BY created_at LIMIT 50",
    )
    .all(now - s.commandHistoryRetentionMs);
  let removed = 0,
    backlog = rows.length === 50;
  for (const { id } of rows) {
    const n = db
      .prepare(
        'DELETE FROM command_execution_events WHERE sequence IN (SELECT sequence FROM command_execution_events WHERE command_id=? LIMIT ?)',
      )
      .run(id, s.rowsPerBatch).changes;
    removed += n;
    if (n < s.rowsPerBatch)
      removed += db.prepare('DELETE FROM command_executions WHERE id=?').run(id).changes;
    else backlog = true;
  }
  return { removed, backlog };
}
function pruneEvents(db, s, now) {
  if (!s.eventStreamRetentionMs) return { removed: 0, backlog: false };
  let removed = 0,
    backlog = false;
  // Age events themselves: an active conversation must not retain every old turn forever.
  // Keep the last sequence as a reconnect watermark, plus the latest complete snapshot.
  const eventKind = db
    .prepare('PRAGMA table_info(agent_execution_events)')
    .all()
    .some((x) => x.name === 'kind')
    ? 'kind'
    : "json_extract(data,'$.kind')";
  const tables = [
    [
      'agent_execution_events',
      'execution_id',
      `AND sequence <> (SELECT max(e.sequence) FROM agent_execution_events e WHERE e.execution_id=agent_execution_events.execution_id) AND NOT (${eventKind}='snapshot')`,
    ],
    [
      'workflow_run_events',
      'run_id',
      "AND EXISTS (SELECT 1 FROM workflow_runs p WHERE p.id=workflow_run_events.run_id AND p.status IN ('succeeded','failed','cancelled','timed_out'))",
    ],
    [
      'coder_run_events',
      'run_id',
      "AND EXISTS (SELECT 1 FROM coder_runs p WHERE p.id=coder_run_events.run_id AND p.status IN ('succeeded','failed','cancelled'))",
    ],
    [
      'agent_runtime_events',
      'run_id',
      "AND EXISTS (SELECT 1 FROM agent_runtime_runs p WHERE p.id=agent_runtime_events.run_id AND p.status IN ('completed','failed','cancelled','interrupted'))",
    ],
  ];
  for (const [table, , extra] of tables) {
    if (!tableExists(db, table)) continue;
    // Before the migration, usage is still in the runtime events; never discard it.
    if (
      table === 'agent_runtime_events' &&
      !db
        .prepare('PRAGMA table_info(agent_runtime_runs)')
        .all()
        .some((x) => x.name === 'usage')
    )
      continue;
    const count = db
      .prepare(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE created_at < ? ${extra} LIMIT ?)`,
      )
      .run(now - s.eventStreamRetentionMs, s.rowsPerBatch).changes;
    removed += count;
    backlog ||= count >= s.rowsPerBatch;
  }
  return { removed, backlog };
}
function pruneActivityItems(db, s, now) {
  if (!s.eventStreamRetentionMs || !tableExists(db, 'stored_json_items')) return 0;
  return db
    .prepare(
      `DELETE FROM stored_json_items WHERE (owner_id,kind,position) IN (
    SELECT i.owner_id,i.kind,i.position FROM stored_json_items i JOIN chat_codex_tasks p ON p.id=i.owner_id
    WHERE i.kind='activity' AND p.status IN ('succeeded','failed','cancelled')
      AND coalesce(json_extract(i.value,'$.createdAt'),strftime('%Y-%m-%dT%H:%M:%fZ',p.created_at/1000.0,'unixepoch')) < ?
      AND coalesce(json_extract(i.value,'$.phase'),'') <> 'task.round_started'
      AND coalesce(json_extract(i.value,'$.phase'),'') NOT LIKE 'steer.%'
      AND i.position <> (SELECT max(position) FROM stored_json_items j WHERE j.owner_id=i.owner_id AND j.kind='activity') LIMIT ?
  )`,
    )
    .run(new Date(now - s.eventStreamRetentionMs).toISOString(), s.rowsPerBatch).changes;
}
function pruneAge(db, table, column, window, batch, now) {
  if (!window || !tableExists(db, table)) return 0;
  return db
    .prepare(
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? ORDER BY ${column} LIMIT ?)`,
    )
    .run(now - window, batch).changes;
}
// Lossless backfill is resumable and never touches a live execution/task. Legacy-safe
// CLI passes skip it so a running older release can keep reading its database.
function compactPayloads(db, batch) {
  const state = cursorState(db);
  let backlog = false,
    changed = 0;
  for (const [table, column, predicate] of [
    ['agent_tool_calls', 'package_files', "status <> 'running'"],
    ['agent_tool_calls', 'output', "status <> 'running'"],
    ['chat_codex_tasks', 'snapshot', "status NOT IN ('running','waiting_for_input')"],
    [
      'agent_execution_events',
      'data',
      "EXISTS (SELECT 1 FROM agent_executions e WHERE e.id=agent_execution_events.execution_id AND e.status NOT IN ('running','waiting_for_input'))",
    ],
    ['agent_executions', 'capability_snapshot', "status NOT IN ('running','waiting_for_input')"],
  ]) {
    const key = table + column;
    if (state[key] === false) continue;
    const rows = db
      .prepare(
        `SELECT rowid, ${column} AS value FROM ${table} WHERE rowid > ? AND ${predicate} AND length(${column})>=2048 AND ${column} NOT LIKE 'worklite:z1:%' ${table === 'agent_execution_events' ? "AND CASE WHEN json_valid(data) THEN json_extract(data,'$.$workliteZ1') ELSE 'packed' END IS NULL" : ''} ORDER BY rowid LIMIT ?`,
      )
      .all(state[key] ?? 0, batch);
    const put = db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=? AND ${column}=?`);
    for (const row of rows) {
      let value = pack(row.value);
      if (
        table === 'agent_execution_events' &&
        value !== row.value &&
        value.startsWith('worklite:z1:')
      )
        value = JSON.stringify({
          kind: JSON.parse(row.value).kind,
          $workliteZ1: value.slice('worklite:z1:'.length),
        });
      if (value !== row.value) changed += put.run(value, row.rowid, row.value).changes;
    }
    state[key] = rows.length === batch ? rows.at(-1).rowid : false;
    backlog ||= rows.length === batch;
  }
  // Normalize old inline arrays one owner at a time; guards prevent overwriting concurrent changes.
  if (tableExists(db, 'stored_json_items'))
    for (const [table, column, kind] of [
      ['agent_executions', 'model_messages', 'model'],
      ['agent_executions', 'display_messages', 'display'],
      ['chat_codex_tasks', 'activities', 'activity'],
    ]) {
      const rows = db
        .prepare(
          `SELECT id, ${column} AS value FROM ${table} WHERE ${column} <> '[]' AND status NOT IN ('running','waiting_for_input','queued') LIMIT 5`,
        )
        .all();
      const put = db.prepare(
        'INSERT INTO stored_json_items(owner_id,kind,position,value) VALUES(?,?,?,?) ON CONFLICT(owner_id,kind,position) DO UPDATE SET value=excluded.value WHERE value<>excluded.value',
      );
      state.arrayProgress ??= new Map();
      for (const row of rows) {
        const key = kind + ':' + row.id;
        let progress = state.arrayProgress.get(key);
        if (!progress || progress.source !== row.value) progress = { source: row.value, offset: 0 };
        const values = JSON.parse(row.value);
        const encoded = [];
        let bytes = 0,
          offset = progress.offset;
        while (offset < values.length && encoded.length < batch && bytes < 1024 * 1024) {
          const value = JSON.stringify(values[offset]);
          encoded.push({ position: offset++, value });
          bytes += Buffer.byteLength(value);
        }
        const result = db.transaction(() => {
          const current = db
            .prepare(
              `SELECT ${column} AS value FROM ${table} WHERE id=? AND status NOT IN ('running','waiting_for_input','queued')`,
            )
            .get(row.id);
          if (!current || current.value !== row.value) return 'changed';
          for (const item of encoded) put.run(row.id, kind, item.position, item.value);
          if (offset === values.length) {
            const trimmed = db
              .prepare(
                'DELETE FROM stored_json_items WHERE (owner_id,kind,position) IN (SELECT owner_id,kind,position FROM stored_json_items WHERE owner_id=? AND kind=? AND position>=? LIMIT ?)',
              )
              .run(row.id, kind, values.length, batch).changes;
            if (trimmed >= batch) return 'trimming';
            changed += db
              .prepare(`UPDATE ${table} SET ${column}='[]' WHERE id=?`)
              .run(row.id).changes;
            return 'done';
          }
          return 'partial';
        })();
        if (result === 'done' || result === 'changed') state.arrayProgress.delete(key);
        else {
          state.arrayProgress.set(key, { source: row.value, offset });
          backlog = true;
        }
      }
      backlog ||= rows.length === 5;
    }
  return { changed, backlog };
}
async function pass(db, s = settings(), options = {}) {
  const now = options.now ?? Date.now();
  let removed = 0,
    backlog = false,
    changed = 0;
  db.pragma('busy_timeout=100');
  db.pragma('foreign_keys=ON');
  if (options.kind !== 'gateway' && !cursorState(db).indexes) {
    for (const [table, column] of [
      ['agent_tool_calls', 'command_execution_id'],
      ['coder_operations', 'command_id'],
      ['chat_codex_operations', 'command_id'],
    ])
      if (tableExists(db, table))
        db.exec(`CREATE INDEX IF NOT EXISTS ${table}_command_retention_idx ON ${table}(${column})`);
    cursorState(db).indexes = true;
  }
  db.pragma(`journal_size_limit=${Math.floor(s.walSizeLimitBytes)}`);
  if (options.kind !== 'gateway') {
    const history = pruneCommandHistory(db, s, now);
    removed += history.removed;
    backlog ||= history.backlog;
    await pause();
    const command = pruneCommand(db, s, now);
    removed += command.removed;
    backlog ||= command.backlog;
    await pause();
    const packages = s.toolPackageRetentionMs
      ? db
          .prepare(
            "UPDATE agent_tool_calls SET package_files='[]' WHERE id IN (SELECT c.id FROM agent_tool_calls c JOIN agent_executions e ON e.id=c.execution_id WHERE c.created_at < ? AND c.status='completed' AND c.result_appended=1 AND e.status='completed' AND c.package_files <> '[]' LIMIT ?)",
          )
          .run(now - s.toolPackageRetentionMs, Math.min(s.rowsPerBatch, 50)).changes
      : 0;
    changed += packages;
    backlog ||= packages >= Math.min(s.rowsPerBatch, 50);
    await pause();
    const events = pruneEvents(db, s, now);
    removed += events.removed;
    backlog ||= events.backlog;
    await pause();
    const activities = pruneActivityItems(db, s, now);
    removed += activities;
    backlog ||= activities >= s.rowsPerBatch;
    await pause();
    const logs = pruneAge(
      db,
      'api_request_logs',
      'created_at',
      s.apiLogRetentionMs,
      s.rowsPerBatch,
      now,
    );
    removed += logs;
    backlog ||= logs >= s.rowsPerBatch;
    if (!options.legacySafe) {
      const compact = compactPayloads(db, Math.min(s.rowsPerBatch, 50));
      changed += compact.changed;
      backlog ||= compact.backlog;
    }
  } else {
    if (!options.legacySafe) {
      const state = cursorState(db);
      for (const column of ['request_body', 'response_body']) {
        if (state[column] === false) continue;
        const rows = db
          .prepare(
            `SELECT rowid,${column} AS value FROM gateway_request_logs WHERE rowid>? AND length(${column})>=2048 AND ${column} NOT LIKE 'worklite:z1:%' ORDER BY rowid LIMIT 50`,
          )
          .all(state[column] ?? 0);
        const put = db.prepare(
          `UPDATE gateway_request_logs SET ${column}=? WHERE rowid=? AND ${column}=?`,
        );
        for (const row of rows) {
          const value = pack(row.value);
          if (value !== row.value) changed += put.run(value, row.rowid, row.value).changes;
        }
        state[column] = rows.length === 50 ? rows.at(-1).rowid : false;
        backlog ||= rows.length === 50;
      }
    }
    for (const [table, window] of [
      ['gateway_request_logs', s.gatewayLogRetentionMs],
      ['gateway_request_stats', s.gatewayStatsRetentionMs],
    ]) {
      const n = pruneAge(db, table, 'occurred_at', window, s.rowsPerBatch, now);
      removed += n;
      backlog ||= n >= s.rowsPerBatch;
      await pause();
    }
  }
  // Incremental auto-vacuum must have been enabled before first tables were created.
  // Do not silently run a full VACUUM on a live database using auto_vacuum=NONE.
  const incremental = db.pragma('auto_vacuum', { simple: true }) === 2;
  if (incremental) {
    for (
      let pages = 0;
      pages < s.incrementalVacuumPages && db.pragma('freelist_count', { simple: true }) > 0;
      pages += 16
    ) {
      db.pragma(`incremental_vacuum(${Math.min(16, s.incrementalVacuumPages - pages)})`);
      await pause();
    }
  }
  db.pragma('busy_timeout=0');
  const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)')[0];
  const freePages = db.pragma('freelist_count', { simple: true });
  return {
    removed,
    changed,
    freePages,
    backlog: backlog || (incremental && freePages > 0),
    checkpoint,
  };
}
module.exports = { settings, pass, pruneCommand, pruneEvents, pack };
if (require.main === module && parentPort) {
  const db = new Database(workerData.path);
  let running = false;
  parentPort.on('message', async () => {
    if (running) return;
    running = true;
    try {
      parentPort.postMessage({
        report: await pass(db, workerData.settings, { kind: workerData.kind }),
      });
    } catch (error) {
      parentPort.postMessage({ error: error.message });
    } finally {
      running = false;
    }
  });
} else if (require.main === module) {
  const args = process.argv.slice(2),
    path = args.find((x) => !x.startsWith('--'));
  if (!path) {
    console.error(
      'Usage: node scripts/sqlite-maintenance.cjs <database> [--gateway] [--catch-up] [--legacy-safe]',
    );
    process.exitCode = 1;
  } else
    (async () => {
      const db = new Database(resolve(path), { fileMustExist: true });
      let total = 0,
        passes = 0,
        report,
        retries = 0;
      const now = Date.now();
      for (;;) {
        try {
          report = await pass(db, settings(), {
            kind: args.includes('--gateway') ? 'gateway' : 'main',
            legacySafe: args.includes('--legacy-safe'),
            now,
          });
          retries = 0;
        } catch (error) {
          if (error.code === 'SQLITE_BUSY' && retries++ < 30) {
            await new Promise((done) => setTimeout(done, 100));
            report = { backlog: true };
            continue;
          }
          throw error;
        }
        total += report.removed;
        passes++;
        if (passes % 50 === 0) console.log(JSON.stringify({ passes, total, ...report }));
        if (!args.includes('--catch-up') || !report.backlog) break;
      }
      console.log(JSON.stringify({ path: resolve(path), passes, total, ...report }));
      db.close();
    })().catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
