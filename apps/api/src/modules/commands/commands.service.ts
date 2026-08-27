import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import type { CommandExecutionEvent as CommandEventView, CommandExecutionView, CreateCommandRequest } from '@worklite/contracts';
import { commandExecutionEvents, commandExecutions, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';

type CommandEventListener = (event: CommandEventView) => void;

@Injectable()
export class CommandsService {
  private readonly activeProcesses = new Map<string, ChildProcess>();
  private readonly completionPromises = new Map<string, Promise<CommandExecutionView>>();
  private readonly cancellationRequested = new Set<string>();
  private readonly listeners = new Set<CommandEventListener>();

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(input: CreateCommandRequest): Promise<CommandExecutionView> {
    if (typeof input?.command !== 'string' || !input.command.trim()) {
      throw new BadRequestException('A command is required.');
    }

    const id = `cmd_${randomUUID()}`;
    const cwd = process.cwd();
    await this.db.insert(commandExecutions).values({ id, command: input.command, cwd, status: 'queued' });
    await this.persistEvent(id, 'lifecycle', 'Command queued.');

    const completion = Promise.resolve()
      .then(() => this.execute(id))
      .finally(() => this.completionPromises.delete(id));
    this.completionPromises.set(id, completion);
    return this.get(id);
  }

  async executeAndWait(command: string): Promise<{ execution: CommandExecutionView; output: string }> {
    const created = await this.create({ command });
    const execution = await this.waitForCompletion(created.id);
    const output = await this.output(created.id);
    return {
      execution,
      output,
    };
  }

  async waitForCompletion(commandId: string): Promise<CommandExecutionView> {
    return this.completionPromises.get(commandId) ?? this.get(commandId);
  }

  async output(commandId: string): Promise<string> {
    const events = await this.events(commandId);
    return events.filter((event) => event.type === 'stdout' || event.type === 'stderr').map((event) => event.data).join('');
  }

  async list(): Promise<CommandExecutionView[]> {
    const rows = await this.db.select().from(commandExecutions).orderBy(desc(commandExecutions.createdAt));
    return rows.map(toView);
  }

  async get(commandId: string): Promise<CommandExecutionView> {
    const [row] = await this.db.select().from(commandExecutions).where(eq(commandExecutions.id, commandId)).limit(1);
    if (!row) throw new NotFoundException('Command not found.');
    return toView(row);
  }

  async events(commandId: string, afterSequence = 0): Promise<CommandEventView[]> {
    await this.get(commandId);
    const rows = await this.db.select().from(commandExecutionEvents)
      .where(and(eq(commandExecutionEvents.commandId, commandId), gt(commandExecutionEvents.sequence, afterSequence)))
      .orderBy(asc(commandExecutionEvents.sequence));
    return rows.map(toEventView);
  }

  subscribe(listener: CommandEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async cancel(commandId: string): Promise<CommandExecutionView> {
    const execution = await this.get(commandId);
    if (isTerminal(execution.status)) return execution;

    const now = new Date();
    if (execution.status === 'queued') {
      const [cancelled] = await this.db.update(commandExecutions)
        .set({ status: 'cancelled', finishedAt: now })
        .where(and(eq(commandExecutions.id, commandId), eq(commandExecutions.status, 'queued')))
        .returning();
      if (cancelled) {
        await this.persistEvent(commandId, 'lifecycle', 'Command cancelled before startup.');
        return toView(cancelled);
      }
    }

    this.cancellationRequested.add(commandId);
    if (execution.status !== 'cancelling') {
      await this.db.update(commandExecutions).set({ status: 'cancelling' }).where(eq(commandExecutions.id, commandId));
      await this.persistEvent(commandId, 'lifecycle', 'Cancellation requested.');
    }

    const child = this.activeProcesses.get(commandId);
    const pid = child?.pid ?? execution.pid;
    if (pid) {
      terminateProcessGroup(pid, 'SIGTERM');
      setTimeout(() => terminateProcessGroup(pid, 'SIGKILL'), 1_000).unref();
    }

    if (!child) {
      await this.db.update(commandExecutions).set({ status: 'cancelled', finishedAt: new Date(), signal: 'SIGTERM' }).where(eq(commandExecutions.id, commandId));
      await this.persistEvent(commandId, 'lifecycle', 'Command cancelled.');
      this.cancellationRequested.delete(commandId);
    }
    return this.get(commandId);
  }

  private async execute(commandId: string): Promise<CommandExecutionView> {
    const startedAt = new Date();
    const [claimed] = await this.db.update(commandExecutions)
      .set({ status: 'running', startedAt })
      .where(and(eq(commandExecutions.id, commandId), eq(commandExecutions.status, 'queued')))
      .returning();
    if (!claimed) return this.get(commandId);

    await this.persistEvent(commandId, 'lifecycle', 'Command started.');
    const child = spawn('/bin/sh', ['-lc', claimed.command], {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.activeProcesses.set(commandId, child);
    if (child.pid) await this.db.update(commandExecutions).set({ pid: child.pid }).where(eq(commandExecutions.id, commandId));

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let eventQueue = Promise.resolve();
    const enqueue = (type: 'stdout' | 'stderr', data: string) => {
      if (!data) return;
      eventQueue = eventQueue.then(() => this.persistEvent(commandId, type, data)).then(() => undefined);
    };
    child.stdout?.on('data', (chunk: Buffer) => enqueue('stdout', stdoutDecoder.write(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => enqueue('stderr', stderrDecoder.write(chunk)));

    if (this.cancellationRequested.has(commandId) && child.pid) terminateProcessGroup(child.pid, 'SIGTERM');

    return new Promise<CommandExecutionView>((resolve) => {
      let settled = false;
      const finish = async (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
        if (settled) return;
        settled = true;
        enqueue('stdout', stdoutDecoder.end());
        enqueue('stderr', stderrDecoder.end());
        await eventQueue;

        const cancelled = this.cancellationRequested.has(commandId);
        const status = cancelled ? 'cancelled' : spawnError || exitCode !== 0 ? 'failed' : 'succeeded';
        if (spawnError) await this.persistEvent(commandId, 'stderr', `${spawnError.message}\n`);
        await this.db.update(commandExecutions).set({
          status,
          exitCode,
          signal,
          finishedAt: new Date(),
        }).where(eq(commandExecutions.id, commandId));
        await this.persistEvent(commandId, 'lifecycle', status === 'cancelled' ? 'Command cancelled.' : status === 'succeeded' ? 'Command completed.' : 'Command failed.');
        this.activeProcesses.delete(commandId);
        this.cancellationRequested.delete(commandId);
        resolve(await this.get(commandId));
      };

      child.once('error', (error) => { void finish(null, null, error); });
      child.once('close', (code, signal) => { void finish(code, signal); });
    });
  }

  private async persistEvent(commandId: string, type: 'stdout' | 'stderr' | 'lifecycle', data: string): Promise<void> {
    const [row] = await this.db.insert(commandExecutionEvents).values({ commandId, type, data }).returning();
    const event = toEventView(row);
    for (const listener of this.listeners) listener(event);
  }
}

function toView(row: typeof commandExecutions.$inferSelect): CommandExecutionView {
  return {
    id: row.id,
    command: row.command,
    cwd: row.cwd,
    status: row.status,
    pid: row.pid,
    exitCode: row.exitCode,
    signal: row.signal,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function toEventView(row: typeof commandExecutionEvents.$inferSelect): CommandEventView {
  return {
    sequence: row.sequence,
    commandId: row.commandId,
    type: row.type,
    data: row.data,
    createdAt: row.createdAt.toISOString(),
  };
}

function isTerminal(status: CommandExecutionView['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function terminateProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The process group may already have exited.
  }
}
