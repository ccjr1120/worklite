// @vitest-environment node
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, initializeDatabase } from './client';
import {
  agentExecutions,
  agentExecutionEvents,
  agentRuntimeEvents,
  agentRuntimeRuns,
  agentRuntimeSessions,
  agentToolCalls,
  commandExecutionEvents,
  commandExecutions,
} from './schema';
import {
  agentExecutionColumns,
  appendExecutionMessages,
  executionUpdates,
  encodeMessageState,
  patchExecutionMessages,
  projectTaskColumns,
} from './stored-arrays';
import { packJson, unpackJson, packText, unpackText } from './packed-json';
import { databaseMaintenanceSettings, runDatabaseMaintenance } from './maintenance';
import { SqliteMaintenanceWorker } from './maintenance-worker';

const databases: ReturnType<typeof createDb>[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.$client.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function database(path = ':memory:') {
  const db = createDb(path);
  databases.push(db);
  await initializeDatabase(db);
  return db;
}
const message = (content: string) => ({ role: 'user' as const, content });

describe('bounded storage', () => {
  it('round-trips historical JSON and packed payloads losslessly', () => {
    const value = { text: '中文 abc '.repeat(10000), items: [1, null] };
    expect(packJson(value).length).toBeLessThan(JSON.stringify(value).length / 10);
    expect(unpackJson(packJson(value))).toEqual(value);
    expect(unpackJson(JSON.stringify(value))).toEqual(value);
    expect(unpackText(packText(value.text))).toBe(value.text);
  });

  it('appends only new message rows and rolls back with the guarded parent update', async () => {
    const db = await database();
    db.insert(agentExecutions)
      .values({
        id: 'owner',
        workspaceId: 'workspace_personal',
        agentId: 'agt_system_helper_chat',
        status: 'completed',
        modelMessages: [message('first')],
      })
      .run();
    db.update(agentExecutions)
      .set(
        executionUpdates('owner', {
          modelMessages: appendExecutionMessages('owner', 'model', [message('second')]),
        }),
      )
      .where(eq(agentExecutions.id, 'owner'))
      .run();
    const before = (db.$client.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    db.update(agentExecutions)
      .set(
        executionUpdates('owner', {
          modelMessages: appendExecutionMessages('owner', 'model', [message('third')]),
        }),
      )
      .where(eq(agentExecutions.id, 'owner'))
      .run();
    expect(
      (db.$client.prepare('SELECT total_changes() AS n').get() as { n: number }).n - before,
    ).toBe(3);
    expect(
      db
        .select(agentExecutionColumns)
        .from(agentExecutions)
        .where(eq(agentExecutions.id, 'owner'))
        .get()?.modelMessages,
    ).toEqual(['first', 'second', 'third'].map(message));
    db.update(agentExecutions)
      .set(executionUpdates('owner', { modelMessages: [message('wrong')] }))
      .where(and(eq(agentExecutions.id, 'owner'), eq(agentExecutions.status, 'running')))
      .run();
    expect(() =>
      db.transaction(() => {
        db.update(agentExecutions)
          .set(executionUpdates('owner', { modelMessages: [message('rolled back')] }))
          .where(eq(agentExecutions.id, 'owner'))
          .run();
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(
      db
        .select(agentExecutionColumns)
        .from(agentExecutions)
        .where(eq(agentExecutions.id, 'owner'))
        .get()?.modelMessages,
    ).toEqual(['first', 'second', 'third'].map(message));
    db.update(agentExecutions)
      .set(executionUpdates('owner', { modelMessages: [] }))
      .where(eq(agentExecutions.id, 'owner'))
      .run();
    expect(
      db
        .select(agentExecutionColumns)
        .from(agentExecutions)
        .where(eq(agentExecutions.id, 'owner'))
        .get()?.modelMessages,
    ).toEqual([]);
  });

  it('checkpoints only changed positions and catches mutations of SDK message objects', async () => {
    const db = await database();
    const messages = [message('unchanged '.repeat(10000)), message('before')];
    db.insert(agentExecutions)
      .values({
        id: 'owner',
        workspaceId: 'workspace_personal',
        agentId: 'agt_system_helper_chat',
        status: 'running',
        modelMessages: messages,
      })
      .run();
    const previous = encodeMessageState(messages);
    messages[1].content = 'after';
    const patch = patchExecutionMessages(previous, messages);
    expect(patch.changed).toBe(true);
    const update = db
      .update(agentExecutions)
      .set({ modelMessages: patch.value })
      .where(eq(agentExecutions.id, 'owner'));
    expect(JSON.stringify(update.toSQL().params).length).toBeLessThan(500);
    update.run();
    expect(
      db
        .select(agentExecutionColumns)
        .from(agentExecutions)
        .where(eq(agentExecutions.id, 'owner'))
        .get()?.modelMessages,
    ).toEqual(messages);
    expect(patchExecutionMessages(patch.encoded, messages).changed).toBe(false);
    const truncated = patchExecutionMessages(patch.encoded, [messages[0]]);
    db.update(agentExecutions)
      .set({ modelMessages: truncated.value })
      .where(eq(agentExecutions.id, 'owner'))
      .run();
    expect(
      db
        .select(agentExecutionColumns)
        .from(agentExecutions)
        .where(eq(agentExecutions.id, 'owner'))
        .get()?.modelMessages,
    ).toEqual([messages[0]]);
  });

  it('backfills arrays in bounded chunks without exposing partially copied history', async () => {
    const db = await database();
    const messages = Array.from({ length: 30 }, (_, i) => message(String(i)));
    db.insert(agentExecutions)
      .values({
        id: 'owner',
        workspaceId: 'workspace_personal',
        agentId: 'agt_system_helper_chat',
        status: 'completed',
        modelMessages: messages,
      })
      .run();
    const settings = {
      ...databaseMaintenanceSettings({}),
      rowsPerBatch: 5,
      incrementalVacuumPages: 1,
    };
    for (let i = 0; i < 7; i++) {
      await runDatabaseMaintenance(db.$client, settings);
      expect(
        db
          .select(agentExecutionColumns)
          .from(agentExecutions)
          .where(eq(agentExecutions.id, 'owner'))
          .get()?.modelMessages,
      ).toEqual(messages);
    }
    expect(
      db.$client
        .prepare("SELECT model_messages AS value FROM agent_executions WHERE id='owner'")
        .get(),
    ).toEqual({ value: '[]' });
  });

  it('keeps compressed snapshot events replayable and their kind index queryable', async () => {
    const db = await database();
    db.insert(agentExecutions)
      .values({
        id: 'owner',
        workspaceId: 'workspace_personal',
        agentId: 'agt_system_helper_chat',
        status: 'completed',
      })
      .run();
    const data = { kind: 'snapshot', execution: { output: '原始事件 '.repeat(10000) } };
    db.insert(agentExecutionEvents).values({ executionId: 'owner', sequence: 1, data }).run();
    expect(
      db.select().from(agentExecutionEvents).where(eq(agentExecutionEvents.kind, 'snapshot')).get()
        ?.data,
    ).toEqual(data);
    const raw = db.$client
      .prepare("SELECT data FROM agent_execution_events WHERE execution_id='owner'")
      .get() as { data: string };
    expect(raw.data.length).toBeLessThan(JSON.stringify(data).length / 10);
    expect(JSON.parse(raw.data).kind).toBe('snapshot');
  });

  it('bounds expired command tails by UTF-8 bytes and keeps lifecycle, recent and active output', async () => {
    const db = await database(),
      old = new Date(Date.now() - 10 * 86400000);
    for (const id of ['old', 'recent', 'active'])
      db.insert(commandExecutions)
        .values({
          id,
          command: 'test',
          cwd: '/',
          status: id === 'active' ? 'running' : 'succeeded',
          createdAt: old,
        })
        .run();
    db.insert(commandExecutionEvents)
      .values([
        { commandId: 'old', type: 'lifecycle', data: 'started', createdAt: old },
        { commandId: 'old', type: 'stdout', data: 'discard', createdAt: old },
        { commandId: 'old', type: 'stderr', data: '文'.repeat(500), createdAt: old },
        { commandId: 'recent', type: 'stdout', data: '文'.repeat(500) },
        { commandId: 'active', type: 'stdout', data: '文'.repeat(500), createdAt: old },
      ])
      .run();
    const settings = {
      ...databaseMaintenanceSettings({}),
      commandStreamTailBytes: 100,
      incrementalVacuumPages: 1,
    };
    await runDatabaseMaintenance(db.$client, settings);
    const events = db.select().from(commandExecutionEvents).all();
    const tail = events
      .filter((event) => event.commandId === 'old' && event.type !== 'lifecycle')
      .map((event) => event.data)
      .join('');
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(100);
    expect(tail).not.toContain('�');
    expect(events.some((event) => event.type === 'lifecycle')).toBe(true);
    expect(events.find((event) => event.commandId === 'active')?.data.length).toBe(500);
    expect(events.find((event) => event.commandId === 'recent')?.data.length).toBe(500);
  });

  it('expires old events in a recently updated conversation and keeps usage and reconnect watermarks', async () => {
    const db = await database(),
      old = Date.now() - 30 * 86400000;
    db.insert(agentExecutions)
      .values({
        id: 'owner',
        workspaceId: 'workspace_personal',
        agentId: 'agt_system_helper_chat',
        status: 'running',
      })
      .run();
    const put = db.$client.prepare(
      'INSERT INTO agent_execution_events(execution_id,sequence,kind,data,created_at) VALUES(?,?,?,?,?)',
    );
    put.run(
      'owner',
      1,
      'message_delta',
      JSON.stringify({ kind: 'message_delta', delta: 'expired' }),
      old,
    );
    put.run('owner', 2, 'snapshot', JSON.stringify({ kind: 'snapshot', execution: {} }), old);
    put.run('owner', 3, 'status', JSON.stringify({ kind: 'status', status: 'completed' }), old);
    db.insert(agentRuntimeSessions)
      .values({
        id: 'owner',
        workspaceId: 'workspace_personal',
        runtime: 'codex',
        resourceDirectory: '/',
        launch: { executor: 'codex', commandArguments: ['codex'], model: null },
      })
      .run();
    db.insert(agentRuntimeRuns)
      .values({ id: 'turn', sessionId: 'owner', status: 'completed' })
      .run();
    db.insert(agentRuntimeEvents)
      .values({
        id: 'usage',
        runId: 'turn',
        sequence: 1,
        createdAt: new Date(old),
        data: {
          kind: 'activity',
          phase: 'usage',
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        },
      })
      .run();
    await runDatabaseMaintenance(db.$client, {
      ...databaseMaintenanceSettings({}),
      incrementalVacuumPages: 1,
    });
    expect(
      db.$client.prepare('SELECT sequence FROM agent_execution_events ORDER BY sequence').all(),
    ).toEqual([{ sequence: 2 }, { sequence: 3 }]);
    expect(db.select().from(agentRuntimeEvents).all()).toEqual([]);
    expect(db.select().from(agentRuntimeRuns).get()?.usage?.totalTokens).toBe(12);
  });

  it('runs a real worker on another connection while timers continue, then reclaims the file', async () => {
    const dir = mkdtempSync(resolve('.data/storage-worker-test-'));
    directories.push(dir);
    const path = join(dir, 'test.db'),
      db = await database(path);
    db.$client.exec('CREATE TABLE padding(data TEXT)');
    const insert = db.$client.prepare('INSERT INTO padding VALUES(?)');
    db.$client.transaction(() => {
      for (let i = 0; i < 100; i++) insert.run('x'.repeat(8192));
    })();
    db.$client.exec('DELETE FROM padding');
    const worker = new SqliteMaintenanceWorker(path, {
      ...databaseMaintenanceSettings({}),
      incrementalVacuumPages: 1024,
    });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      const report = await worker.run();
      expect(report.freePages).toBe(0);
      expect(ticks).toBeGreaterThan(5);
    } finally {
      clearInterval(timer);
      await worker.stop();
    }
    expect(db.$client.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
  });

  it('expires only unused completed tool packages while retaining results and retry evidence', async () => {
    const db = await database(),
      old = new Date(Date.now() - 10 * 86400000);
    for (const status of ['completed', 'running', 'failed'] as const) {
      db.insert(agentExecutions)
        .values({
          id: status,
          workspaceId: 'workspace_personal',
          agentId: 'agt_system_helper_chat',
          status,
        })
        .run();
      db.insert(agentToolCalls)
        .values({
          id: status,
          executionId: status,
          workspaceId: 'workspace_personal',
          agentId: 'agt_system_helper_chat',
          toolCallId: status,
          toolName: 'skill_script',
          workingDirectory: '/',
          status: 'completed',
          resultAppended: true,
          createdAt: old,
          output: 'result survives',
          packageFiles: [{ path: 'script', content: 'evidence' }],
        })
        .run();
    }
    await runDatabaseMaintenance(db.$client, {
      ...databaseMaintenanceSettings({}),
      incrementalVacuumPages: 1,
    });
    const rows = db.select().from(agentToolCalls).all();
    expect(rows.find((row) => row.id === 'completed')).toMatchObject({
      packageFiles: [],
      output: 'result survives',
    });
    for (const status of ['running', 'failed'])
      expect(rows.find((row) => row.id === status)?.packageFiles).toHaveLength(1);
  });

  it('expires command records after their window without removing active commands or saved tool output', async () => {
    const db = await database(),
      old = new Date(Date.now() - 40 * 86400000);
    db.insert(agentExecutions)
      .values({
        id: 'owner',
        workspaceId: 'workspace_personal',
        agentId: 'agt_system_helper_chat',
        status: 'completed',
      })
      .run();
    for (const id of ['expired', 'active'])
      db.insert(commandExecutions)
        .values({
          id,
          command: 'test',
          cwd: '/',
          status: id === 'active' ? 'running' : 'succeeded',
          createdAt: old,
        })
        .run();
    db.insert(agentToolCalls)
      .values({
        id: 'tool',
        executionId: 'owner',
        workspaceId: 'workspace_personal',
        agentId: 'agt_system_helper_chat',
        toolCallId: 'tool',
        toolName: 'builtin',
        workingDirectory: '/',
        commandExecutionId: 'expired',
        output: 'saved result',
      })
      .run();
    db.insert(commandExecutionEvents)
      .values({ commandId: 'expired', type: 'stdout', data: 'old', createdAt: old })
      .run();
    await runDatabaseMaintenance(db.$client, {
      ...databaseMaintenanceSettings({}),
      incrementalVacuumPages: 1,
    });
    expect(
      db
        .select()
        .from(commandExecutions)
        .all()
        .map((row) => row.id),
    ).toEqual(['active']);
    expect(db.select().from(agentToolCalls).get()).toMatchObject({
      commandExecutionId: null,
      output: 'saved result',
    });
  });

  it('expires old task activity while retaining its latest progress and round bookkeeping', async () => {
    const db = await database();
    db.insert(agentExecutions)
      .values({
        id: 'owner',
        workspaceId: 'workspace_personal',
        agentId: 'agt_system_helper_chat',
        status: 'completed',
      })
      .run();
    db.insert(agentToolCalls)
      .values({
        id: 'task',
        executionId: 'owner',
        workspaceId: 'workspace_personal',
        agentId: 'agt_system_helper_chat',
        toolCallId: 'task',
        toolName: 'builtin',
        workingDirectory: '/',
      })
      .run();
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    const activities = [
      { phase: 'task.round_started', createdAt: old },
      { phase: 'stdout', text: 'expired', createdAt: old },
      { phase: 'steer.applied', createdAt: old },
      { phase: 'stdout', text: 'latest', createdAt: old },
    ];
    db.$client
      .prepare(
        'INSERT INTO chat_codex_tasks(id,workspace_id,execution_id,goal,project_directory,model,snapshot,status,activities) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'task',
        'workspace_personal',
        'owner',
        'goal',
        '/',
        'model',
        '{}',
        'succeeded',
        JSON.stringify(activities),
      );
    const settings = { ...databaseMaintenanceSettings({}), incrementalVacuumPages: 1 };
    await runDatabaseMaintenance(db.$client, settings);
    await runDatabaseMaintenance(db.$client, settings);
    const task = db
      .select(projectTaskColumns)
      .from((await import('./schema')).chatProjectTasks)
      .get();
    expect(task?.activities).toEqual([activities[0], activities[2], activities[3]]);
  });

  it('supports configurable disabled retention and rejects invalid bounds', () => {
    expect(
      databaseMaintenanceSettings({
        COMMAND_STREAM_RETENTION_DAYS: '0',
        RUN_EVENT_RETENTION_DAYS: '0',
        GATEWAY_STATS_RETENTION_DAYS: '0',
      }),
    ).toMatchObject({
      commandStreamRetentionMs: 0,
      eventStreamRetentionMs: 0,
      gatewayStatsRetentionMs: 0,
    });
    expect(
      databaseMaintenanceSettings({
        SQLITE_MAINTENANCE_BATCH_ROWS: '-1',
        SQLITE_MAINTENANCE_INTERVAL_MINUTES: 'wat',
      }),
    ).toMatchObject({ rowsPerBatch: 500, maintenanceIntervalMs: 900000 });
    const require = createRequire(resolve('package.json'));
    expect(
      require(resolve('scripts/sqlite-maintenance.cjs')).settings({}).gatewayStatsRetentionMs,
    ).toBe(90 * 86400000);
  });
});
