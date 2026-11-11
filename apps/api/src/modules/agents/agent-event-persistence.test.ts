import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentExecutionEvents, createDb, type Database } from '@worklite/db';
import type { AgentExecutionEventData, AgentExecutionView } from '@worklite/contracts';
import { AgentExecutionsService } from './agent-executions.service';

let directory: string;
let db: Database;
let maintenance: Database;
type InternalService = {
  writeEvent(id: string, data: AgentExecutionEventData): Promise<void>;
  schedule(request: never, slug: string, id: string): void;
  scheduledExecutions: Map<string, Promise<void>>;
};
let service: InternalService;
const logger = { error: vi.fn() };
const snapshot = (id: string): AgentExecutionEventData => ({ kind: 'snapshot', execution: { id } as AgentExecutionView });

beforeEach(() => {
  directory = mkdtempSync(resolve('.data/agent-event-test-'));
  const path = join(directory, 'test.db');
  db = createDb(path);
  // Exercise the real Drizzle event mapping without booting the application or migrating
  // unrelated tables. The second WAL connection represents the maintenance worker.
  db.$client.exec(`CREATE TABLE agent_execution_events (
    execution_id TEXT NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL,
    data TEXT NOT NULL, created_at INTEGER, PRIMARY KEY (execution_id, sequence)
  ); CREATE TABLE maintenance_writes (value INTEGER);`);
  maintenance = createDb(path);
  maintenance.$client.pragma('busy_timeout = 1');
  logger.error.mockClear();
  service = Object.assign(Object.create(AgentExecutionsService.prototype), {
    db, eventQueues: new Map(), listeners: new Set(), scheduledExecutions: new Map(), logger,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  maintenance?.$client.close();
  db?.$client.close();
  rmSync(directory, { force: true, recursive: true });
});

describe('Agent event persistence under WAL contention', () => {
  it('reproduces the original deferred read-to-write failure despite busy_timeout', () => {
    expect(() => db.$client.transaction(() => {
      db.$client.prepare('SELECT * FROM agent_execution_events').all();
      maintenance.$client.prepare('INSERT INTO maintenance_writes VALUES (1)').run();
      db.$client.prepare('INSERT INTO maintenance_writes VALUES (2)').run();
    })()).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY_SNAPSHOT' }));
  });

  it('reserves the writer before reading and preserves snapshot deduplication and sequence', async () => {
    const transaction = db.transaction.bind(db);
    let blockedWrites = 0;
    vi.spyOn(db, 'transaction').mockImplementation((callback, config) => transaction((tx) => {
      db.$client.prepare('SELECT * FROM agent_execution_events').all();
      try {
        maintenance.$client.prepare('INSERT INTO maintenance_writes VALUES (1)').run();
      } catch (error) {
        expect(error).toMatchObject({ code: 'SQLITE_BUSY' });
        blockedWrites++;
      }
      return callback(tx);
    }, config));
    await service.writeEvent('execution', snapshot('first'));
    await service.writeEvent('execution', snapshot('first'));
    await service.writeEvent('execution', snapshot('second'));
    const rows = db.select().from(agentExecutionEvents).all();
    expect(blockedWrites).toBe(3);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sequence: 2, data: snapshot('second') });
    // The reservation is released after commit.
    expect(maintenance.$client.prepare('INSERT INTO maintenance_writes VALUES (3)').run().changes).toBe(1);
  });

  it('does not poison already queued events after one write fails', async () => {
    vi.spyOn(db, 'transaction').mockImplementationOnce(() => { throw new Error('disk full'); });
    const failed = service.writeEvent('execution', snapshot('first'));
    const following = service.writeEvent('execution', snapshot('second'));
    await expect(failed).rejects.toThrow('disk full');
    await expect(following).resolves.toBeUndefined();
    expect(db.select().from(agentExecutionEvents).get()?.data).toEqual(snapshot('second'));
  });

  it('contains failure-persistence errors at the detached turn boundary and releases scheduling', async () => {
    Object.assign(service, {
      advance: vi.fn().mockRejectedValue(new Error('turn failed')),
      workspaces: { getWorkspace: async () => ({ id: 'workspace' }) },
      markExecutionFailed: vi.fn().mockRejectedValue(new Error('database is locked')),
    });
    service.schedule({} as never, 'personal', 'execution');
    const work = service.scheduledExecutions.get('execution');
    expect(work).toBeDefined();
    await expect(work).resolves.toBeUndefined();
    expect(service.scheduledExecutions.size).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('database is locked'));
  });
});
