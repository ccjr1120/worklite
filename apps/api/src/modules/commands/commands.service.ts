import { StreamBatch } from '../../infrastructure/stream-batch';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { resolve } from 'node:path';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import type { CommandExecutionEvent as CommandEventView, CommandExecutionStatus, CommandExecutionView, CreateCommandRequest } from '@worklite/contracts';
import { commandExecutionEvents, commandExecutions, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';

type CommandEventListener = (event: CommandEventView) => void;

export type CommandReservation = (transaction: Database, commandId: string) => void;

type StdioProcessOptions = {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  onEvent: CommandEventListener;
  started: (child: ChildProcess) => void;
  failed: (error: Error) => void;
};

export type CommandStdioProcess = {
  executionId: string;
  write(data: string): Promise<void>;
  close(): Promise<void>;
  completion: Promise<CommandExecutionView>;
};

@Injectable()
export class CommandsService {
  private readonly activeProcesses = new Map<string, ChildProcess>();
  private readonly completionPromises = new Map<string, Promise<CommandExecutionView>>();
  private readonly pendingStdin = new Map<string, string>();
  private readonly stdioProcesses = new Map<string, StdioProcessOptions>();
  private readonly cancellationRequested = new Set<string>();
  private readonly listeners = new Set<CommandEventListener>();

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(input: CreateCommandRequest): Promise<CommandExecutionView> {
    if (typeof input?.command !== 'string' || !input.command.trim()) {
      throw new BadRequestException('A command is required.');
    }

    return this.createInternal(input.command);
  }

  async createWithInput(command: string, input: string): Promise<CommandExecutionView> {
    if (!command.trim()) throw new BadRequestException('A command is required.');
    return this.createInternal(command, input);
  }

  async createWithReservation(command: string, cwd: string, reservation: CommandReservation): Promise<CommandExecutionView> {
    if (!command.trim()) throw new BadRequestException('A command is required.');
    return this.createInternal(command, undefined, cwd, reservation);
  }

  // Trusted integration transport, never exposed as a browser command API.
  async openStdioProcess(
    argv: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    onEvent: CommandEventListener,
  ): Promise<CommandStdioProcess> {
    if (!argv[0]) throw new BadRequestException('A process executable is required.');
    let started!: (child: ChildProcess) => void;
    let failed!: (error: Error) => void;
    const ready = new Promise<ChildProcess>((resolve, reject) => { started = resolve; failed = reject; });
    void ready.catch(() => undefined);
    const options = { argv, env, onEvent, started, failed };
    const execution = await this.createInternal(argv.map(shellQuote).join(' '), undefined, cwd, undefined, options);
    const completion = this.waitForCompletion(execution.id);
    void completion.then(() => failed(new Error('The stdio process has stopped.')), failed);
    return {
      executionId: execution.id,
      completion,
      write: async (data) => {
        const child = await ready;
        if (!child.stdin || child.stdin.destroyed) throw new Error('The stdio process input is closed.');
        await new Promise<void>((resolve, reject) => child.stdin!.write(data, (error) => error ? reject(error) : resolve()));
      },
      close: async () => { (await ready).stdin?.end(); },
    };
  }

  private async createInternal(
    command: string,
    stdinInput?: string,
    cwd?: string,
    reservation?: CommandReservation,
    stdioProcess?: StdioProcessOptions,
  ): Promise<CommandExecutionView> {
    const id = `cmd_${randomUUID()}`;
    const workingDirectory = resolve(cwd ?? process.cwd());
    this.db.transaction((transaction) => {
      transaction.insert(commandExecutions).values({ id, command, cwd: workingDirectory, status: 'queued' }).run();
      reservation?.(transaction as unknown as Database, id);
    });
    if (stdioProcess) this.stdioProcesses.set(id, stdioProcess);
    await this.persistEvent(id, 'lifecycle', 'Command queued.');
    return this.dispatch(id, stdinInput);
  }

  private dispatch(commandId: string, stdinInput?: string): Promise<CommandExecutionView> {
    const completion = Promise.resolve()
      .then(() => this.execute(commandId))
      .finally(() => {
        this.completionPromises.delete(commandId);
        this.stdioProcesses.delete(commandId);
      });
    this.completionPromises.set(commandId, completion);
    if (stdinInput !== undefined) this.pendingStdin.set(commandId, stdinInput);
    return this.get(commandId);
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

  async output(commandId: string, stream?: 'stdout' | 'stderr'): Promise<string> {
    const events = await this.events(commandId);
    return events.filter((event) => stream ? event.type === stream : event.type === 'stdout' || event.type === 'stderr').map((event) => event.data).join('');
  }

  /**
   * The unfiltered list is the whole command history, which reaches tens of thousands of
   * rows on a long-lived deployment. The filters are additive read-only projections, so an
   * omitted option keeps the full list; callers that only need active work pass statuses.
   */
  async list(options: { statuses?: CommandExecutionStatus[]; limit?: number } = {}): Promise<CommandExecutionView[]> {
    const statement = this.db.select().from(commandExecutions)
      .where(options.statuses?.length ? inArray(commandExecutions.status, options.statuses) : undefined)
      .orderBy(desc(commandExecutions.createdAt));
    const rows = options.limit === undefined ? await statement : await statement.limit(options.limit);
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
        this.pendingStdin.delete(commandId);
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
    if (!claimed) {
      this.stdioProcesses.get(commandId)?.failed(new Error('The stdio process was cancelled before startup.'));
      return this.get(commandId);
    }

    await this.persistEvent(commandId, 'lifecycle', 'Command started.');
    const stdinInput = this.pendingStdin.get(commandId);
    this.pendingStdin.delete(commandId);
    const stdioProcess = this.stdioProcesses.get(commandId);
    const child = spawn(stdioProcess?.argv[0] ?? '/bin/sh', stdioProcess ? [...stdioProcess.argv.slice(1)] : ['-lc', claimed.command], {
      cwd: claimed.cwd,
      env: stdioProcess ? { ...process.env, ...stdioProcess.env } : process.env,
      detached: true,
      stdio: [stdioProcess || stdinInput !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    this.activeProcesses.set(commandId, child);

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    type Chunk = { type: 'stdout' | 'stderr'; data: string };
    const batches = new StreamBatch<Chunk[]>(
      (chunks) => this.persistEvents(commandId, chunks),
      (left, right) => {
        const last = left.at(-1)!;
        if (last.type === right[0].type) last.data += right[0].data;
        else left.push(...right);
        return left;
      },
      (chunks) => chunks.reduce((bytes, chunk) => bytes + Buffer.byteLength(chunk.data) + 64, 0),
      stdioProcess ? 10 : 50,
    );
    const enqueue = (type: 'stdout' | 'stderr', data: string) => {
      if (!data) return;
      batches.push([{ type, data }]);
    };
    child.stdout?.on('data', (chunk: Buffer) => enqueue('stdout', stdoutDecoder.write(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => enqueue('stderr', stderrDecoder.write(chunk)));
    child.stdin?.on('error', (error) => stdioProcess?.failed(error));
    stdioProcess?.started(child);
    if (stdinInput !== undefined) child.stdin?.end(stdinInput);
    if (child.pid) this.db.update(commandExecutions).set({ pid: child.pid }).where(eq(commandExecutions.id, commandId)).run();

    if (this.cancellationRequested.has(commandId) && child.pid) terminateProcessGroup(child.pid, 'SIGTERM');

    return new Promise<CommandExecutionView>((resolve) => {
      let settled = false;
      const finish = async (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
        if (settled) return;
        settled = true;
        enqueue('stdout', stdoutDecoder.end());
        enqueue('stderr', stderrDecoder.end());
        await batches.flush();

        const cancelled = this.cancellationRequested.has(commandId);
        const status = cancelled ? 'cancelled' : spawnError || exitCode !== 0 ? 'failed' : 'succeeded';
        if (spawnError) await this.persistEvent(commandId, 'stderr', `${spawnError.message}\n`);
        if (spawnError) stdioProcess?.failed(spawnError);
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
    await this.persistEvents(commandId, [{ type, data }]);
  }

  private async persistEvents(commandId: string, chunks: Array<{ type: 'stdout' | 'stderr' | 'lifecycle'; data: string }>): Promise<void> {
    const rows = this.db.insert(commandExecutionEvents).values(chunks.map((chunk) => ({ commandId, ...chunk }))).returning().all();
    for (const row of rows.sort((left, right) => left.sequence - right.sequence)) {
      const event = toEventView(row);
      this.stdioProcesses.get(commandId)?.onEvent(event);
      for (const listener of this.listeners) listener(event);
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
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
