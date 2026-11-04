import { ConflictException, Inject, Injectable, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { agentExecutions, agentRuntimeEvents, agentRuntimeInteractions, agentRuntimeRuns, agentRuntimeSessions, type Database, type StoredAgentRuntimeEvent } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { ProjectExecutorService } from './project-executor.service';
import type { ProjectExecutorRequest, ProjectExecutorSteerPort } from './project-executor.types';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type RuntimeTurnRequest = Omit<ProjectExecutorRequest, 'launch' | 'runtimeSession' | 'resourceDirectory' | 'onQuestion' | 'onApproval' | 'owner'> & {
  sessionId: string;
  runtime: 'claude' | 'codex';
  onInteraction: (id: string, question: string) => Promise<void>;
};
type ActiveRun = { controller: AbortController; done: Promise<void>; steerPort: ProjectExecutorSteerPort };

/** WorkLite owns task state; the adapters own native context and the agent/tool loop. */
@Injectable()
export class AgentRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly active = new Map<string, ActiveRun>();
  private readonly answers = new Map<string, { sessionId: string; resolve: (answer: string) => void }>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly executors: ProjectExecutorService,
  ) {}

  capabilities(runtime: 'claude' | 'codex') { return this.executors.capabilities(runtime); }

  async onModuleInit(): Promise<void> {
    // A native history can be resumed later, but a lost in-flight callback cannot be recovered.
    this.db.transaction((tx) => {
      const runs = tx.select().from(agentRuntimeRuns).where(inArray(agentRuntimeRuns.status, ['running', 'waiting_for_input'])).all();
      for (const run of runs) {
        tx.update(agentRuntimeInteractions).set({ status: 'interrupted', updatedAt: new Date() }).where(and(eq(agentRuntimeInteractions.runId, run.id), eq(agentRuntimeInteractions.status, 'pending'))).run();
        tx.update(agentRuntimeRuns).set({ status: 'interrupted', error: 'Runtime interrupted by service restart. No work was replayed.', updatedAt: new Date() }).where(eq(agentRuntimeRuns.id, run.id)).run();
        tx.update(agentRuntimeSessions).set({ status: 'interrupted', updatedAt: new Date() }).where(eq(agentRuntimeSessions.id, run.sessionId)).run();
        tx.update(agentExecutions).set({ status: 'failed', errorCode: 'restarted', error: 'Agent runtime interrupted by service restart. Inspect prior effects before continuing.', pendingQuestion: null, updatedAt: new Date() }).where(and(eq(agentExecutions.id, run.sessionId), inArray(agentExecutions.status, ['running', 'waiting_for_input', 'failed']))).run();
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    const active = [...this.active.values()];
    for (const run of active) run.controller.abort(new Error('WorkLite is shutting down.'));
    await Promise.all(active.map((run) => run.done));
  }

  executeTurn(request: RuntimeTurnRequest): Promise<string> {
    if (this.active.has(request.sessionId)) return Promise.reject(new ConflictException('This Agent session is already running.'));
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    let settle!: () => void;
    const steerPort: ProjectExecutorSteerPort = {};
    const active = { controller, steerPort, done: new Promise<void>((resolve) => { settle = resolve; }) };
    this.active.set(request.sessionId, active);
    return this.run({ ...request, steerPort, signal: controller.signal }).finally(() => {
      request.signal.removeEventListener('abort', abort);
      this.active.delete(request.sessionId);
      settle();
    });
  }

  async waitForStop(sessionId: string): Promise<void> {
    await this.active.get(sessionId)?.done;
  }

  async steer(workspaceId: string, sessionId: string, text: string): Promise<boolean> {
    const session = this.db.select().from(agentRuntimeSessions).where(and(eq(agentRuntimeSessions.id, sessionId), eq(agentRuntimeSessions.workspaceId, workspaceId))).get();
    if (!session) throw new NotFoundException('Agent runtime session not found.');
    const active = this.active.get(sessionId);
    if (!active || active.controller.signal.aborted || !this.capabilities(session.runtime).steer) return false;
    return await active.steerPort.deliver?.(text) ?? false;
  }

  async answer(workspaceId: string, sessionId: string, interactionId: string, answer: string, accept: (tx: Transaction) => void): Promise<void> {
    const waiter = this.answers.get(interactionId);
    if (!waiter || waiter.sessionId !== sessionId) throw new ConflictException('This runtime question is no longer active.');
    this.db.transaction((tx) => {
      const session = tx.select().from(agentRuntimeSessions).where(and(eq(agentRuntimeSessions.id, sessionId), eq(agentRuntimeSessions.workspaceId, workspaceId))).get();
      if (!session) throw new NotFoundException('Agent runtime session not found.');
      const updated = tx.update(agentRuntimeInteractions).set({ status: 'answered', answer, updatedAt: new Date() }).where(and(eq(agentRuntimeInteractions.id, interactionId), eq(agentRuntimeInteractions.status, 'pending'))).returning().get();
      if (!updated) throw new ConflictException('This runtime question has already been answered.');
      tx.update(agentRuntimeRuns).set({ status: 'running', updatedAt: new Date() }).where(eq(agentRuntimeRuns.id, updated.runId)).run();
      accept(tx);
    });
    this.answers.delete(interactionId);
    waiter.resolve(answer);
  }

  async closeSession(workspaceId: string, sessionId: string): Promise<void> {
    if (this.active.has(sessionId)) throw new ConflictException('Cancel the active turn before closing its session.');
    const session = this.db.select().from(agentRuntimeSessions).where(and(eq(agentRuntimeSessions.id, sessionId), eq(agentRuntimeSessions.workspaceId, workspaceId))).get();
    if (!session) throw new NotFoundException('Agent runtime session not found.');
    this.db.update(agentRuntimeSessions).set({ status: 'closed', updatedAt: new Date() }).where(eq(agentRuntimeSessions.id, sessionId)).run();
    // Native history is retained by its backend; only WorkLite's materialized resources are removed.
    await rm(session.resourceDirectory, { recursive: true, force: true });
  }

  private async run(request: RuntimeTurnRequest): Promise<string> {
    request.signal.throwIfAborted();
    const owner = this.db.select({ id: agentExecutions.id }).from(agentExecutions).where(and(eq(agentExecutions.id, request.sessionId), eq(agentExecutions.workspaceId, request.workspaceId))).get();
    if (!owner) throw new NotFoundException('Agent conversation not found in this workspace.');
    let session = this.db.select().from(agentRuntimeSessions).where(and(eq(agentRuntimeSessions.id, request.sessionId), eq(agentRuntimeSessions.workspaceId, request.workspaceId))).get();
    if (session?.status === 'closed') throw new ConflictException('This Agent session is closed. Start a new conversation.');
    if (session && session.runtime !== request.runtime) throw new ConflictException('A conversation cannot switch runtimes. Start a new conversation.');
    if (!session) {
      if (request.model) await this.executors.requireModel(request.workspaceId, request.runtime, request.model);
      const launch = await this.executors.captureLaunch(request.runtime, request.model);
      request.signal.throwIfAborted();
      const root = process.env.WORKLITE_AGENT_RUNTIME_DIR ?? join(homedir(), '.worklite', 'agent-sessions');
      await mkdir(root, { recursive: true, mode: 0o700 });
      const resourceDirectory = await mkdtemp(join(root, 'session-'));
      try {
        session = this.db.insert(agentRuntimeSessions).values({ id: request.sessionId, workspaceId: request.workspaceId, runtime: request.runtime, launch, resourceDirectory }).returning().get();
      } catch (error) {
        await rm(resourceDirectory, { recursive: true, force: true });
        throw error;
      }
    } else if (!(await stat(session.resourceDirectory).catch(() => null))?.isDirectory()) {
      throw new ConflictException('Agent session resources are missing. Start a new conversation.');
    }
    const runId = `arun_${randomUUID()}`;
    this.db.transaction((tx) => {
      const acquired = tx.update(agentRuntimeSessions).set({ status: 'running', updatedAt: new Date() }).where(and(eq(agentRuntimeSessions.id, session!.id), inArray(agentRuntimeSessions.status, ['idle', 'interrupted']))).run();
      if (!acquired.changes) throw new ConflictException('This Agent session is unavailable.');
      tx.insert(agentRuntimeRuns).values({ id: runId, sessionId: session!.id, status: 'running' }).run();
    });
    let externalSessionId = session.externalSessionId;
    let sequence = 0;
    const event = (data: StoredAgentRuntimeEvent) => {
      this.db.insert(agentRuntimeEvents).values({ id: `are_${randomUUID()}`, runId, sequence: ++sequence, data }).run();
    };
    try {
      request.signal.throwIfAborted();
      const output = await this.executors.execute({
        ...request, model: session.launch.model, owner: 'agent', launch: session.launch, resourceDirectory: session.resourceDirectory,
        runtimeSession: {
          ...(session.externalSessionId ? { resumeId: session.externalSessionId } : {}),
          onSession: async (id) => {
            if (externalSessionId && externalSessionId !== id) throw new ConflictException('The backend returned a different session. Continuation stopped.');
            externalSessionId = id;
            this.db.update(agentRuntimeSessions).set({ externalSessionId: id, updatedAt: new Date() }).where(eq(agentRuntimeSessions.id, session!.id)).run();
          },
        },
        onTextDelta: async (delta) => { event({ kind: 'text_delta', delta }); await request.onTextDelta?.(delta); },
        onEvent: async (activity) => {
          event({ kind: 'activity', phase: activity.phase, ...(activity.usage ? { usage: activity.usage } : {}), ...(activity.itemId ? { itemId: activity.itemId } : {}), ...(activity.itemType ? { itemType: activity.itemType } : {}) });
          await request.onEvent?.(activity);
        },
        onQuestion: (question) => this.ask(request, runId, question, event),
        onApproval: async (description) => {
          const answer = await this.ask(request, runId, `${description}\nReply approve / 同意 to allow this operation, or decline / 拒绝 to deny it.`, event, 'approval');
          return ['approve', 'yes', '同意', '确认', '允许'].includes(answer.trim().toLowerCase());
        },
      });
      request.signal.throwIfAborted();
      this.settle(session.id, runId, 'completed');
      event({ kind: 'settled', status: 'completed' });
      return output;
    } catch (error) {
      const status = request.signal.aborted ? 'cancelled' : 'failed';
      // Backend failure must also release any still-pending question/approval callback.
      this.active.get(request.sessionId)?.controller.abort(error);
      this.settle(session.id, runId, status, error instanceof Error ? error.message : 'Agent runtime failed.');
      event({ kind: 'settled', status });
      throw error;
    }
  }

  private async ask(request: RuntimeTurnRequest, runId: string, question: string, event: (event: StoredAgentRuntimeEvent) => void, kind: 'question' | 'approval' = 'question'): Promise<string> {
    request.signal.throwIfAborted();
    const id = `ari_${randomUUID()}`;
    this.db.transaction((tx) => {
      tx.insert(agentRuntimeInteractions).values({ id, runId, question, kind, status: 'pending' }).run();
      tx.update(agentRuntimeRuns).set({ status: 'waiting_for_input', updatedAt: new Date() }).where(eq(agentRuntimeRuns.id, runId)).run();
    });
    let rejectAnswer!: (reason: unknown) => void;
    const answer = new Promise<string>((resolve, reject) => {
      rejectAnswer = reject;
      this.answers.set(id, { sessionId: request.sessionId, resolve });
    });
    // Attach a rejection observer before any async publication or cancellation can occur.
    void answer.catch(() => undefined);
    const abort = () => rejectAnswer(request.signal.reason ?? new Error('Agent question cancelled.'));
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    try {
      event({ kind: 'question', interactionId: id });
      await request.onInteraction(id, question);
      return await answer;
    } finally {
      request.signal.removeEventListener('abort', abort);
      this.answers.delete(id);
    }
  }

  private settle(sessionId: string, runId: string, status: 'completed' | 'failed' | 'cancelled', error?: string): void {
    this.db.transaction((tx) => {
      tx.update(agentRuntimeRuns).set({ status, error: error ?? null, updatedAt: new Date() }).where(eq(agentRuntimeRuns.id, runId)).run();
      tx.update(agentRuntimeSessions).set({ status: status === 'completed' ? 'idle' : 'interrupted', updatedAt: new Date() }).where(eq(agentRuntimeSessions.id, sessionId)).run();
      tx.update(agentRuntimeInteractions).set({ status: 'cancelled', updatedAt: new Date() }).where(and(eq(agentRuntimeInteractions.runId, runId), eq(agentRuntimeInteractions.status, 'pending'))).run();
    });
  }
}
