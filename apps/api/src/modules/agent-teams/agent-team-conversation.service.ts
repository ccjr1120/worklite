import { runtimeAdmissionClosed } from '../../infrastructure/runtime-upgrade-state';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { and, asc, desc, eq, gt, inArray, ne } from 'drizzle-orm';
import type { Request } from 'express';
import type {
  AgentTeamConversationDocument,
  AgentTeamConversationEvent,
  AgentTeamConversationEventType,
  AgentTeamConversationIntakeView,
  AgentTeamConversationMessage,
  AgentTeamConversationPendingInputView,
  AgentTeamConversationRunStateView,
  AgentTeamConversationView,
  AgentTeamDocumentDownloadView,
  AgentTeamDocumentView,
  AgentTeamMode,
  AgentTeamRole,
  AgentTeamRunEvent,
  AgentTeamRunStatus,
  AgentTeamTaskAttemptStatus,
  SendAgentTeamConversationMessageRequest,
} from '@worklite/contracts';
import {
  agentTeamConversationEvents,
  agentTeamConversationMessages,
  agentTeamConversations,
  agentTeamDocuments,
  agentTeamIntakes,
  agentTeamPendingInputs,
  agentTeamRunEvents,
  agentTeamRuns,
  agentTeamTaskAttempts,
  agentTeams,
  type AgentTeamConversation as ConversationRow,
  type AgentTeamConversationMessage as MessageRow,
  type AgentTeamIntake as IntakeRow,
  type AgentTeamRun as RunRow,
  type Database,
} from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { agentTeamDocumentFileName, AgentTeamRuntimeService } from './agent-team-runtime.service';

type ConversationDatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type ConversationListener = (event: AgentTeamConversationEvent) => void;
type IntakeField = 'goal' | 'projectDirectory' | 'mode';
type IntakeChanges = Partial<Pick<IntakeRow, 'goal' | 'projectDirectory' | 'mode' | 'unresolvedField' | 'status' | 'runId'>>;
type NewMessage = {
  intakeId: string | null;
  runId: string | null;
  speaker: MessageRow['speaker'];
  kind: MessageRow['kind'];
  payload: unknown;
  deduplicationKey?: string;
};

const ACTIVE_RUN_STATUSES: AgentTeamRunStatus[] = ['queued', 'running', 'waiting_for_input', 'paused'];
const MODES: AgentTeamMode[] = ['plan_only', 'validate_existing', 'implement_and_validate'];

@Injectable()
export class AgentTeamConversationService implements OnModuleInit, OnModuleDestroy {
  private readonly listeners = new Set<ConversationListener>();
  private runtimeEventQueue: Promise<void> = Promise.resolve();
  private unsubscribeRuntime?: () => void;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly runtime: AgentTeamRuntimeService,
  ) {}

  onModuleInit(): void {
    this.unsubscribeRuntime = this.runtime.subscribe((event) => {
      this.runtimeEventQueue = this.runtimeEventQueue
        .then(() => this.handleRuntimeEvent(event))
        .catch(() => undefined);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribeRuntime?.();
    this.listeners.clear();
  }

  async getConversation(request: Request, workspaceSlug: string, teamId: string): Promise<AgentTeamConversationView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const conversation = await this.ensureConversation(workspace.id, teamId);
    await this.resumeIntakes(conversation.id);
    await this.projectRunHistory(conversation.id);
    return this.conversationView(conversation.id);
  }

  async sendMessage(
    request: Request,
    workspaceSlug: string,
    teamId: string,
    input: SendAgentTeamConversationMessageRequest,
  ): Promise<AgentTeamConversationView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const conversation = await this.ensureConversation(workspace.id, teamId);
    const submissionId = validateSubmissionId(input?.submissionId);
    const text = (input?.text ?? '').trim();
    if (!text) throw new BadRequestException('A conversation message is required.');
    const mentionsCoordinator = validateMentions(input?.mentions) || /^@Coordinator\b/i.test(text);
    const authorizedCommands = normalizeCommands(input?.authorizedCommands);

    const existing = await findMessageBySubmission(this.db, conversation.id, submissionId);
    if (existing) {
      assertSameSubmission(existing, text, mentionsCoordinator, authorizedCommands);
      await this.retryExistingSubmission(existing);
      await this.resumeIntakes(conversation.id);
      await this.projectRunHistory(conversation.id);
      return this.conversationView(conversation.id);
    }
    const [existingIntake] = await this.db.select().from(agentTeamIntakes)
      .where(and(
        eq(agentTeamIntakes.conversationId, conversation.id),
        eq(agentTeamIntakes.submissionId, submissionId),
      ))
      .limit(1);
    if (existingIntake) throw new BadRequestException('The submission id is already used by another message.');

    await this.resumeIntakes(conversation.id);
    if (mentionsCoordinator) {
      const parsed = parseTaskRequest(text);
      const explicitDirectory = parsed.projectDirectory
        ? await validateProjectDirectory(parsed.projectDirectory)
        : null;
      const rememberedDirectory = explicitDirectory ?? await this.validRememberedDirectory(conversation);
      const active = await this.hasActiveWork(conversation.id);
      const unresolvedField = firstMissingField(parsed.goal, rememberedDirectory, parsed.mode);
      const intake = await this.createTaskIntake({
        conversation,
        submissionId,
        goal: parsed.goal,
        projectDirectory: rememberedDirectory,
        mode: parsed.mode,
        unresolvedField,
        status: active ? 'queued' : 'collecting',
        text,
      });
      if (intake.status === 'queued') return this.conversationView(conversation.id);
      await this.advanceIntake(intake);
      return this.conversationView(conversation.id);
    }

    const [collecting] = await this.db.select().from(agentTeamIntakes)
      .where(and(
        eq(agentTeamIntakes.conversationId, conversation.id),
        eq(agentTeamIntakes.status, 'collecting'),
      ))
      .orderBy(asc(agentTeamIntakes.createdAt))
      .limit(1);
    if (collecting?.unresolvedField) {
      const field = collecting.unresolvedField;
      const value = await parseIntakeAnswer(field, text);
      const answered = await this.updateIntakeAndAppendAnswer(collecting, field, value, submissionId);
      if (answered) await this.advanceIntake(answered);
      return this.conversationView(conversation.id);
    }

    const pending = await this.currentPendingInput(conversation.id);
    if (pending) {
      if (pending.kind === 'operation_recovery') {
        throw new BadRequestException('Operation recovery requires its structured decision control.');
      }
      await this.appendMessage(conversation.id, {
        intakeId: await intakeIdForRun(conversation.id, pending.runId, this.db),
        runId: pending.runId,
        speaker: 'user',
        kind: 'run_answer',
        payload: {
          pendingInputId: pending.pendingInputId,
          scopeRevision: pending.scopeRevision,
          text,
          mentions: mentionsCoordinator,
          authorizedCommands,
        },
        deduplicationKey: `send:${submissionId}`,
      });
      await this.runtime.answer(pending.runId, {
        pendingInputId: pending.pendingInputId,
        scopeRevision: pending.scopeRevision,
        answer: text,
        ...(authorizedCommands.length > 0 ? { authorizedCommands } : {}),
      });
      await this.projectRunHistory(conversation.id);
      return this.conversationView(conversation.id);
    }

    await this.appendMessage(conversation.id, {
      intakeId: null,
      runId: null,
      speaker: 'user',
      kind: 'note',
      payload: { text },
      deduplicationKey: `send:${submissionId}`,
    });
    return this.conversationView(conversation.id);
  }

  async eventsForConversation(
    conversationId: string,
    afterSequence: number,
  ): Promise<AgentTeamConversationEvent[]> {
    const rows = await this.db.select().from(agentTeamConversationEvents)
      .where(and(
        eq(agentTeamConversationEvents.conversationId, conversationId),
        gt(agentTeamConversationEvents.sequence, afterSequence),
      ))
      .orderBy(asc(agentTeamConversationEvents.sequence));
    return rows.map(toConversationEventView);
  }

  subscribe(listener: ConversationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getDocument(request: Request, workspaceSlug: string, documentId: string): Promise<AgentTeamDocumentView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    let document = await this.getDocumentRow(documentId, workspace.id);
    if (document.deliveryStatus !== 'delivered') {
      await this.runtime.deliverRunDocuments(document.runId, workspace.id);
      document = await this.getDocumentRow(documentId, workspace.id);
    }
    return toDocumentView(document);
  }

  async downloadDocument(
    request: Request,
    workspaceSlug: string,
    documentId: string,
  ): Promise<AgentTeamDocumentDownloadView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    let document = await this.getDocumentRow(documentId, workspace.id);
    if (document.deliveryStatus !== 'delivered') {
      await this.runtime.deliverRunDocuments(document.runId, workspace.id);
      document = await this.getDocumentRow(documentId, workspace.id);
    }
    if (document.deliveryStatus !== 'delivered') {
      throw new NotFoundException('The Team document file is not available.');
    }
    return {
      fileName: agentTeamDocumentFileName(document.key, document.revision),
      content: document.content,
    };
  }

  private async retryExistingSubmission(message: MessageRow): Promise<void> {
    if (message.kind === 'run_answer') {
      const payload = message.payload as {
        pendingInputId?: unknown;
        scopeRevision?: unknown;
        text?: unknown;
        authorizedCommands?: unknown;
      };
      const pendingInputId = typeof payload.pendingInputId === 'string' ? payload.pendingInputId : null;
      const scopeRevision = typeof payload.scopeRevision === 'number' ? payload.scopeRevision : null;
      if (!message.runId || !pendingInputId || scopeRevision === null) return;
      const status = await pendingInputStatus(this.db, pendingInputId);
      if (status !== 'pending') return;
      const authorizedCommands = normalizeCommands(payload.authorizedCommands);
      await this.runtime.answer(message.runId, {
        pendingInputId,
        scopeRevision,
        answer: String(payload.text ?? ''),
        ...(authorizedCommands.length > 0 ? { authorizedCommands } : {}),
      });
      return;
    }

    if (!message.intakeId || message.kind !== 'task_request' && message.kind !== 'answer') return;
    const [intake] = await this.db.select().from(agentTeamIntakes)
      .where(eq(agentTeamIntakes.id, message.intakeId))
      .limit(1);
    if (!intake || intake.status !== 'failed' || firstMissingField(intake.goal, intake.projectDirectory, intake.mode)) return;
    const claimed = await this.claimIntake(intake.id, 'failed', 'collecting');
    if (claimed) await this.advanceIntake(claimed);
  }

  private async ensureConversation(workspaceId: string, teamId: string): Promise<ConversationRow> {
    const [team] = await this.db.select({ id: agentTeams.id })
      .from(agentTeams)
      .where(and(eq(agentTeams.id, teamId), eq(agentTeams.workspaceId, workspaceId)))
      .limit(1);
    if (!team) throw new NotFoundException('Agent Team not found.');

    const [existing] = await this.db.select().from(agentTeamConversations)
      .where(and(
        eq(agentTeamConversations.workspaceId, workspaceId),
        eq(agentTeamConversations.teamId, teamId),
      ))
      .limit(1);
    if (existing) return existing;

    const now = new Date();
    await this.db.insert(agentTeamConversations).values({
      id: `atconv_${randomUUID()}`,
      workspaceId,
      teamId,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().run();
    const [created] = await this.db.select().from(agentTeamConversations)
      .where(and(
        eq(agentTeamConversations.workspaceId, workspaceId),
        eq(agentTeamConversations.teamId, teamId),
      ))
      .limit(1);
    if (!created) throw new NotFoundException('Agent Team conversation not found.');
    return created;
  }

  private async createTaskIntake(input: {
    conversation: ConversationRow;
    submissionId: string;
    goal: string | null;
    projectDirectory: string | null;
    mode: AgentTeamMode | null;
    unresolvedField: IntakeField | null;
    status: 'queued' | 'collecting';
    text: string;
  }): Promise<IntakeRow> {
    const now = new Date();
    const intakeId = `atintake_${randomUUID()}`;
    const messageId = `atmsg_${randomUUID()}`;
    const events: AgentTeamConversationEvent[] = [];
    const [created] = await this.db.transaction((transaction) => {
      transaction.insert(agentTeamIntakes).values({
        id: intakeId,
        workspaceId: input.conversation.workspaceId,
        conversationId: input.conversation.id,
        submissionId: input.submissionId,
        goal: input.goal,
        projectDirectory: input.projectDirectory,
        mode: input.mode,
        unresolvedField: input.unresolvedField,
        status: input.status,
        createdAt: now,
        updatedAt: now,
      }).run();
      const [message] = transaction.insert(agentTeamConversationMessages).values({
        id: messageId,
        workspaceId: input.conversation.workspaceId,
        conversationId: input.conversation.id,
        sequence: nextMessageSequence(transaction, input.conversation.id),
        intakeId,
        runId: null,
        speaker: 'user',
        kind: 'task_request',
        payload: { text: input.text, mentions: true },
        deduplicationKey: `send:${input.submissionId}`,
        createdAt: now,
      }).returning().all();
      events.push(insertConversationEvent(transaction, input.conversation.id, 'message', toMessageView(message), now));
      transaction.update(agentTeamConversations).set({ updatedAt: now })
        .where(eq(agentTeamConversations.id, input.conversation.id)).run();
      return transaction.select().from(agentTeamIntakes).where(eq(agentTeamIntakes.id, intakeId)).limit(1).all();
    });
    this.publish(events);
    if (!created) throw new NotFoundException('Agent Team intake was not created.');
    return created;
  }

  private async advanceIntake(intake: IntakeRow): Promise<void> {
    const [current] = await this.db.select().from(agentTeamIntakes)
      .where(eq(agentTeamIntakes.id, intake.id))
      .limit(1);
    if (!current || current.status !== 'collecting') return;

    const missing = firstMissingField(current.goal, current.projectDirectory, current.mode);
    if (missing) {
      await this.askForIntakeField(current, missing);
      return;
    }

    if (await this.hasOtherActiveWork(current.conversationId, current.id)) {
      await this.claimIntake(current.id, 'collecting', 'queued');
      return;
    }

    const claimed = await this.claimIntake(current.id, 'collecting', 'starting', { unresolvedField: null });
    if (!claimed) return;
    try {
      const run = await this.runtime.createRun(current.workspaceId, {
        intent: current.goal!,
        projectDirectory: current.projectDirectory!,
        mode: current.mode!,
      }, {
        intakeId: current.id,
        conversationId: current.conversationId,
      });
      const now = new Date();
      const [started] = await this.db.update(agentTeamIntakes).set({
        runId: run.id,
        status: 'started',
        unresolvedField: null,
        updatedAt: now,
      }).where(and(eq(agentTeamIntakes.id, current.id), eq(agentTeamIntakes.status, 'starting'))).returning();
      if (!started) {
        const [alreadyStarted] = await this.db.select().from(agentTeamIntakes)
          .where(and(
            eq(agentTeamIntakes.id, current.id),
            eq(agentTeamIntakes.status, 'started'),
            eq(agentTeamIntakes.runId, run.id),
          ))
          .limit(1);
        if (!alreadyStarted) throw new NotFoundException('The Agent Team conversation intake was not started.');
      } else {
        await this.emitIntakeUpdate(started);
      }
      await this.db.update(agentTeamConversations).set({
        latestProjectDirectory: current.projectDirectory,
        updatedAt: now,
      }).where(eq(agentTeamConversations.id, current.conversationId)).run();
      await this.emitRunState(current.conversationId, run.id);
      await this.projectRunEventHistory(current.conversationId, run.id);
    } catch (error) {
      const [afterFailure] = await this.db.select().from(agentTeamIntakes)
        .where(eq(agentTeamIntakes.id, current.id))
        .limit(1);
      if (afterFailure?.runId) {
        if (afterFailure.status === 'starting') await this.updateIntake(afterFailure.id, { status: 'started' });
      } else if (afterFailure?.status === 'starting') {
        await this.updateIntake(afterFailure.id, { status: 'failed' });
      }
      throw error;
    }
  }

  private async askForIntakeField(intake: IntakeRow, field: IntakeField): Promise<void> {
    const question = intakeQuestion(field);
    const options = field === 'projectDirectory'
      ? await this.recentProjectDirectories(intake.conversationId).then((directories) => directories.map((directory) => ({
        value: directory,
        label: directory,
      })))
      : field === 'mode'
        ? MODES.map((mode) => ({ value: mode, label: mode }))
        : [];
    const updated = await this.updateIntake(intake.id, {
      unresolvedField: field,
    });
    await this.appendMessage(intake.conversationId, {
      intakeId: intake.id,
      runId: null,
      speaker: 'coordinator',
      kind: 'coordinator_question',
      payload: { field, text: question, options },
      deduplicationKey: `intake-question:${intake.id}:${field}`,
    });
    await this.emitIntakeUpdate(updated);
  }

  private async updateIntakeAndAppendAnswer(
    intake: IntakeRow,
    field: IntakeField,
    value: string,
    submissionId: string,
  ): Promise<IntakeRow | null> {
    const now = new Date();
    const events: AgentTeamConversationEvent[] = [];
    const updated = await this.db.transaction((transaction) => {
      const [row] = transaction.update(agentTeamIntakes).set({
        ...(field === 'goal' ? { goal: value } : {}),
        ...(field === 'projectDirectory' ? { projectDirectory: value } : {}),
        ...(field === 'mode' ? { mode: value as AgentTeamMode } : {}),
        unresolvedField: null,
        updatedAt: now,
      }).where(and(
        eq(agentTeamIntakes.id, intake.id),
        eq(agentTeamIntakes.status, 'collecting'),
        eq(agentTeamIntakes.unresolvedField, field),
      )).returning().all();
      if (row) {
        const [message] = transaction.insert(agentTeamConversationMessages).values({
          id: `atmsg_${randomUUID()}`,
          workspaceId: intake.workspaceId,
          conversationId: intake.conversationId,
          sequence: nextMessageSequence(transaction, intake.conversationId),
          intakeId: intake.id,
          runId: intake.runId,
          speaker: 'user',
          kind: 'answer',
          payload: { field, text: value, mentions: false },
          deduplicationKey: `send:${submissionId}`,
          createdAt: now,
        }).returning().all();
        events.push(insertConversationEvent(transaction, intake.conversationId, 'message', toMessageView(message), now));
        transaction.update(agentTeamConversations).set({ updatedAt: now })
          .where(eq(agentTeamConversations.id, intake.conversationId)).run();
      }
      return row;
    });
    this.publish(events);
    return updated;
  }

  private async claimIntake(
    intakeId: string,
    from: IntakeRow['status'],
    to: IntakeRow['status'],
    changes: IntakeChanges = {},
  ): Promise<IntakeRow | null> {
    const [claimed] = await this.db.update(agentTeamIntakes).set({
      ...changes,
      status: to,
      updatedAt: new Date(),
    }).where(and(eq(agentTeamIntakes.id, intakeId), eq(agentTeamIntakes.status, from))).returning();
    if (!claimed) return null;
    await this.emitIntakeUpdate(claimed);
    return claimed;
  }

  private async updateIntake(intakeId: string, changes: IntakeChanges): Promise<IntakeRow> {
    const [updated] = await this.db.update(agentTeamIntakes).set({
      ...changes,
      updatedAt: new Date(),
    }).where(eq(agentTeamIntakes.id, intakeId)).returning();
    if (!updated) throw new NotFoundException('Agent Team intake not found.');
    await this.emitIntakeUpdate(updated);
    return updated;
  }

  private async appendMessage(conversationId: string, message: NewMessage): Promise<MessageRow | null> {
    const now = new Date();
    let event: AgentTeamConversationEvent | undefined;
    const inserted = await this.db.transaction((transaction) => {
      if (message.deduplicationKey) {
        const [existing] = transaction.select({ id: agentTeamConversationMessages.id })
          .from(agentTeamConversationMessages)
          .where(and(
            eq(agentTeamConversationMessages.conversationId, conversationId),
            eq(agentTeamConversationMessages.deduplicationKey, message.deduplicationKey),
          ))
          .limit(1).all();
        if (existing) return null;
      }
      const [row] = transaction.insert(agentTeamConversationMessages).values({
        id: `atmsg_${randomUUID()}`,
        workspaceId: (transaction.select({ workspaceId: agentTeamConversations.workspaceId })
          .from(agentTeamConversations)
          .where(eq(agentTeamConversations.id, conversationId))
          .limit(1).all())[0]!.workspaceId,
        conversationId,
        sequence: nextMessageSequence(transaction, conversationId),
        intakeId: message.intakeId,
        runId: message.runId,
        speaker: message.speaker,
        kind: message.kind,
        payload: message.payload,
        deduplicationKey: message.deduplicationKey ?? null,
        createdAt: now,
      }).returning().all();
      event = insertConversationEvent(transaction, conversationId, 'message', toMessageView(row), now);
      transaction.update(agentTeamConversations).set({ updatedAt: now })
        .where(eq(agentTeamConversations.id, conversationId)).run();
      return row;
    });
    if (event) this.publish([event]);
    return inserted;
  }

  private async emitIntakeUpdate(intake: IntakeRow): Promise<void> {
    const now = new Date();
    const event = await this.db.transaction((transaction) => insertConversationEvent(
      transaction,
      intake.conversationId,
      'intake.updated',
      toIntakeView(intake),
      now,
    ));
    this.publish([event]);
  }

  private async emitRunState(conversationId: string, runId: string): Promise<void> {
    const [run] = await this.db.select().from(agentTeamRuns).where(eq(agentTeamRuns.id, runId)).limit(1);
    if (!run) return;
    const retryableTaskKeys = await retryableTaskKeysForRun(run.id, this.db);
    const payload: AgentTeamConversationRunStateView = {
      runId: run.id,
      status: run.status,
      mode: run.mode,
      projectDirectory: run.projectDirectory,
      retryableTaskKey: retryableTaskKeys[0] ?? null,
      retryableTaskKeys,
      progress: await this.runtime.getRunProgress(run.id),
    };
    const now = new Date();
    const event = await this.db.transaction((transaction) => insertConversationEvent(
      transaction,
      conversationId,
      'run.state',
      payload,
      now,
    ));
    this.publish([event]);
  }

  private async handleRuntimeEvent(event: AgentTeamRunEvent): Promise<void> {
    const [intake] = await this.db.select({ conversationId: agentTeamIntakes.conversationId })
      .from(agentTeamIntakes)
      .where(eq(agentTeamIntakes.runId, event.runId))
      .limit(1);
    if (!intake) {
      await this.resumeConversationsForDirectRun(event.runId, event);
      return;
    }
    await this.projectRunEvent(intake.conversationId, event);
    if (event.type === 'input.answered' || event.type === 'run.progress') {
      await this.emitRunState(intake.conversationId, event.runId);
    }
    if (event.type === 'run.status' && isTerminalRunStatus((event.payload as { status?: unknown }).status)) {
      await this.resumeIntakes(intake.conversationId);
    }
    return;
  }

  private async resumeConversationsForDirectRun(runId: string, event: AgentTeamRunEvent): Promise<void> {
    if (event.type !== 'run.status' || !isTerminalRunStatus((event.payload as { status?: unknown }).status)) return;
    const conversations = await this.db.select({ id: agentTeamConversations.id })
      .from(agentTeamRuns)
      .innerJoin(agentTeamConversations, eq(agentTeamConversations.teamId, agentTeamRuns.teamId))
      .where(eq(agentTeamRuns.id, runId));
    for (const conversation of conversations) await this.resumeIntakes(conversation.id);
  }

  private async projectRunHistory(conversationId: string): Promise<void> {
    const intakes = await this.db.select({ runId: agentTeamIntakes.runId })
      .from(agentTeamIntakes)
      .where(eq(agentTeamIntakes.conversationId, conversationId));
    const runIds = [...new Set(intakes.flatMap((intake) => intake.runId ? [intake.runId] : []))];
    for (const runId of runIds) {
      await this.projectRunEventHistory(conversationId, runId);
    }
  }

  private async projectRunEventHistory(conversationId: string, runId: string): Promise<void> {
    const rows = await this.db.select().from(agentTeamRunEvents)
      .where(eq(agentTeamRunEvents.runId, runId))
      .orderBy(asc(agentTeamRunEvents.sequence));
    for (const row of rows) {
      await this.projectRunEvent(conversationId, {
        runId: row.runId,
        sequence: row.sequence,
        type: row.type,
        payload: row.payload,
        createdAt: row.createdAt.toISOString(),
      });
    }
  }

  private async projectRunEvent(conversationId: string, event: AgentTeamRunEvent): Promise<void> {
    const deduplicationKey = `run:${event.runId}:${event.sequence}`;
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
    const taskAttemptId = typeof payload.taskAttemptId === 'string' ? payload.taskAttemptId : null;
    const task = taskAttemptId ? await this.taskAttempt(taskAttemptId) : null;
    const role = (typeof payload.role === 'string' ? payload.role : task?.role) as AgentTeamRole | undefined;
    const taskKey = typeof payload.taskKey === 'string' ? payload.taskKey : task?.taskKey ?? null;
    const developerId = typeof payload.developerId === 'string' ? payload.developerId : task?.developerId ?? null;
    const assignmentTitle = typeof payload.assignmentTitle === 'string' ? payload.assignmentTitle : task?.assignmentTitle ?? null;

    if (event.type === 'run.status' || event.type === 'run.outcome') {
      const status = payload.status;
      if (!isRunStatus(status)) return;
      await this.appendMessage(conversationId, {
        intakeId: await intakeIdForRun(conversationId, event.runId, this.db),
        runId: event.runId,
        speaker: 'system',
        kind: 'run_state',
        payload: {
          status,
          taskStatus: null,
          role: null,
          taskKey: null,
          developerId: null,
          assignmentTitle: null,
          outcomeSummary: outcomeSummary(payload.outcome),
        },
        deduplicationKey,
      });
      return;
    }

    if (event.type === 'task.started' || event.type === 'task.completed' || event.type === 'task.failed') {
      const taskStatus: AgentTeamTaskAttemptStatus = event.type === 'task.started'
        ? 'running'
        : event.type === 'task.completed'
          ? 'completed'
          : typeof payload.cancelled === 'boolean' && payload.cancelled
            ? 'cancelled'
            : 'failed';
      const [run] = await this.db.select({ status: agentTeamRuns.status })
        .from(agentTeamRuns)
        .where(eq(agentTeamRuns.id, event.runId))
        .limit(1);
      await this.appendMessage(conversationId, {
        intakeId: await intakeIdForRun(conversationId, event.runId, this.db),
        runId: event.runId,
        speaker: 'system',
        kind: 'run_state',
        payload: {
          status: run?.status ?? 'running',
          taskStatus,
          role: role ?? null,
          taskKey,
          developerId,
          assignmentTitle,
          outcomeSummary: null,
        },
        deduplicationKey,
      });
      return;
    }

    if (event.type === 'input.requested') {
      const pendingInputId = typeof payload.pendingInputId === 'string' ? payload.pendingInputId : null;
      const question = typeof payload.question === 'string' ? payload.question : null;
      const scopeRevision = typeof payload.scopeRevision === 'number' ? payload.scopeRevision : null;
      const operationKey = typeof payload.operationKey === 'string' ? payload.operationKey : null;
      if (!pendingInputId || !question || scopeRevision === null || !task) return;
      await this.appendMessage(conversationId, {
        intakeId: await intakeIdForRun(conversationId, event.runId, this.db),
        runId: event.runId,
        speaker: 'member',
        kind: 'member_question',
        payload: {
          role: task.role,
          taskKey: task.taskKey,
          developerId: task.developerId ?? null,
          assignmentTitle: task.assignmentTitle ?? null,
          pendingInputId,
          scopeRevision,
          kindDetail: operationKey ? 'operation_recovery' : 'question',
          text: question,
          operationKey,
        },
        deduplicationKey,
      });
      return;
    }

    if (event.type === 'document.delivered' || event.type === 'document.delivery_failed') {
      const documentId = typeof payload.documentId === 'string' ? payload.documentId : null;
      if (!documentId) return;
      const [document] = await this.db.select().from(agentTeamDocuments)
        .where(eq(agentTeamDocuments.id, documentId))
        .limit(1);
      if (!document) return;
      const documentTask = await this.taskAttempt(document.taskAttemptId);
      const conversationDocument = toConversationDocument(document, documentTask);
      await this.appendMessage(conversationId, {
        intakeId: await intakeIdForRun(conversationId, event.runId, this.db),
        runId: event.runId,
        speaker: event.type === 'document.delivered' ? 'member' : 'system',
        kind: event.type === 'document.delivered' ? 'file_delivery' : 'delivery_failed',
        payload: event.type === 'document.delivered'
          ? { document: conversationDocument }
          : {
            document: conversationDocument,
            error: typeof payload.error === 'string' ? payload.error : 'File delivery failed.',
          },
        deduplicationKey,
      });
    }
  }

  private async taskAttempt(taskAttemptId: string) {
    const [task] = await this.db.select().from(agentTeamTaskAttempts)
      .where(eq(agentTeamTaskAttempts.id, taskAttemptId))
      .limit(1);
    return task ?? null;
  }

  private async resumeIntakes(conversationId: string): Promise<void> {
    if (runtimeAdmissionClosed()) return;
    const starting = await this.db.select().from(agentTeamIntakes)
      .where(and(
        eq(agentTeamIntakes.conversationId, conversationId),
        eq(agentTeamIntakes.status, 'starting'),
      ))
      .orderBy(asc(agentTeamIntakes.createdAt));
    for (const intake of starting) {
      if (intake.runId) {
        await this.claimIntake(intake.id, 'starting', 'started', { runId: intake.runId });
      } else {
        const collecting = await this.claimIntake(intake.id, 'starting', 'collecting');
        if (collecting) await this.advanceIntake(collecting);
      }
    }

    if (await this.hasActiveWork(conversationId)) return;
    const [queued] = await this.db.select().from(agentTeamIntakes)
      .where(and(
        eq(agentTeamIntakes.conversationId, conversationId),
        eq(agentTeamIntakes.status, 'queued'),
      ))
      .orderBy(asc(agentTeamIntakes.createdAt))
      .limit(1);
    if (!queued) return;
    const collecting = await this.claimIntake(queued.id, 'queued', 'collecting');
    if (collecting) await this.advanceIntake(collecting);
  }

  private async hasActiveWork(conversationId: string): Promise<boolean> {
    const [collecting] = await this.db.select({ id: agentTeamIntakes.id })
      .from(agentTeamIntakes)
      .where(and(
        eq(agentTeamIntakes.conversationId, conversationId),
        inArray(agentTeamIntakes.status, ['collecting', 'starting']),
      ))
      .limit(1);
    if (collecting) return true;
    const [conversation] = await this.db.select({ teamId: agentTeamConversations.teamId })
      .from(agentTeamConversations)
      .where(eq(agentTeamConversations.id, conversationId))
      .limit(1);
    if (!conversation) return false;
    const [activeRun] = await this.db.select({ id: agentTeamRuns.id })
      .from(agentTeamRuns)
      .where(and(
        eq(agentTeamRuns.teamId, conversation.teamId),
        inArray(agentTeamRuns.status, ACTIVE_RUN_STATUSES),
      ))
      .limit(1);
    return Boolean(activeRun);
  }

  private async hasOtherActiveWork(conversationId: string, intakeId: string): Promise<boolean> {
    const [collecting] = await this.db.select({ id: agentTeamIntakes.id })
      .from(agentTeamIntakes)
      .where(and(
        eq(agentTeamIntakes.conversationId, conversationId),
        ne(agentTeamIntakes.id, intakeId),
        inArray(agentTeamIntakes.status, ['collecting', 'starting']),
      ))
      .limit(1);
    if (collecting) return true;
    const [conversation] = await this.db.select({ teamId: agentTeamConversations.teamId })
      .from(agentTeamConversations)
      .where(eq(agentTeamConversations.id, conversationId))
      .limit(1);
    if (!conversation) return false;
    const [activeRun] = await this.db.select({ id: agentTeamRuns.id })
      .from(agentTeamRuns)
      .where(and(
        eq(agentTeamRuns.teamId, conversation.teamId),
        inArray(agentTeamRuns.status, ACTIVE_RUN_STATUSES),
      ))
      .limit(1);
    return Boolean(activeRun);
  }

  private async activeRunRow(conversationId: string): Promise<RunRow | null> {
    const rows = await this.db.select({ run: agentTeamRuns })
      .from(agentTeamIntakes)
      .innerJoin(agentTeamRuns, eq(agentTeamRuns.id, agentTeamIntakes.runId))
      .where(and(
        eq(agentTeamIntakes.conversationId, conversationId),
        inArray(agentTeamRuns.status, ACTIVE_RUN_STATUSES),
      ))
      .orderBy(desc(agentTeamIntakes.createdAt), desc(agentTeamIntakes.updatedAt))
      .limit(1);
    return rows[0]?.run ?? null;
  }

  private async latestRunRow(conversationId: string): Promise<RunRow | null> {
    const rows = await this.db.select({ run: agentTeamRuns })
      .from(agentTeamIntakes)
      .innerJoin(agentTeamRuns, eq(agentTeamRuns.id, agentTeamIntakes.runId))
      .where(eq(agentTeamIntakes.conversationId, conversationId))
      .orderBy(desc(agentTeamIntakes.createdAt), desc(agentTeamIntakes.updatedAt))
      .limit(1);
    return rows[0]?.run ?? null;
  }

  private async currentPendingInputs(conversationId: string): Promise<AgentTeamConversationPendingInputView[]> {
    const run = await this.activeRunRow(conversationId);
    if (!run) return [];
    const pending = await this.db.select().from(agentTeamPendingInputs)
      .where(and(
        eq(agentTeamPendingInputs.runId, run.id),
        eq(agentTeamPendingInputs.status, 'pending'),
      ))
      .orderBy(asc(agentTeamPendingInputs.createdAt));
    return pending.map((row) => ({
      runId: row.runId,
      pendingInputId: row.id,
      taskAttemptId: row.taskAttemptId,
      scopeRevision: row.scopeRevision,
      kind: row.kind,
      question: row.question,
      operationKey: row.operationKey,
    }));
  }

  private async currentPendingInput(conversationId: string): Promise<AgentTeamConversationPendingInputView | null> {
    return (await this.currentPendingInputs(conversationId))[0] ?? null;
  }

  private async conversationView(conversationId: string): Promise<AgentTeamConversationView> {
    const [conversation] = await this.db.select().from(agentTeamConversations)
      .where(eq(agentTeamConversations.id, conversationId))
      .limit(1);
    if (!conversation) throw new NotFoundException('Agent Team conversation not found.');
    const [intakes, messages] = await Promise.all([
      this.db.select().from(agentTeamIntakes)
        .where(eq(agentTeamIntakes.conversationId, conversationId))
        .orderBy(desc(agentTeamIntakes.createdAt))
        .limit(100),
      this.db.select().from(agentTeamConversationMessages)
        .where(eq(agentTeamConversationMessages.conversationId, conversationId))
        .orderBy(asc(agentTeamConversationMessages.sequence)),
    ]);
    const [latestEvent] = await this.db.select({ sequence: agentTeamConversationEvents.sequence })
      .from(agentTeamConversationEvents)
      .where(eq(agentTeamConversationEvents.conversationId, conversationId))
      .orderBy(desc(agentTeamConversationEvents.sequence))
      .limit(1);
    const activeRun = await this.activeRunRow(conversationId);
    const conversationRun = activeRun ?? await this.latestRunRow(conversationId);
    const pendingInputs = await this.currentPendingInputs(conversationId);
    const retryableTaskKeys = conversationRun ? await retryableTaskKeysForRun(conversationRun.id, this.db) : [];
    const recentDirectories = await this.recentProjectDirectories(conversationId);
    const activeIntake = activeRun
      ? intakes.find((intake) => intake.runId === activeRun.id)
      : [...intakes].reverse().find((intake) => intake.status === 'collecting' || intake.status === 'starting' || intake.status === 'queued') ?? null;
    return {
      id: conversation.id,
      teamId: conversation.teamId,
      latestProjectDirectory: conversation.latestProjectDirectory,
      recentProjectDirectories: recentDirectories,
      messages: messages.map(toMessageView),
      intakes: intakes.map(toIntakeView),
      activeIntakeId: activeIntake?.id ?? null,
      activeRun: conversationRun ? {
        runId: conversationRun.id,
        status: conversationRun.status,
        mode: conversationRun.mode,
        projectDirectory: conversationRun.projectDirectory,
        retryableTaskKey: retryableTaskKeys[0] ?? null,
        retryableTaskKeys,
        progress: await this.runtime.getRunProgress(conversationRun.id),
      } : null,
      pendingInput: pendingInputs[0] ?? null,
      pendingInputs,
      lastSequence: latestEvent?.sequence ?? 0,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    };
  }

  private async recentProjectDirectories(conversationId: string): Promise<string[]> {
    const conversation = await this.db.select({ latest: agentTeamConversations.latestProjectDirectory })
      .from(agentTeamConversations)
      .where(eq(agentTeamConversations.id, conversationId))
      .limit(1);
    const rows = await this.db.select({ directory: agentTeamIntakes.projectDirectory })
      .from(agentTeamIntakes)
      .where(eq(agentTeamIntakes.conversationId, conversationId))
      .orderBy(desc(agentTeamIntakes.createdAt))
      .limit(100);
    const candidates = [...conversation.flatMap((row) => row.latest ? [row.latest] : []), ...rows.flatMap((row) => row.directory ? [row.directory] : [])];
    const unique = [...new Set(candidates)];
    const valid = await Promise.all(unique.map(async (directory) => ({
      directory,
      valid: await isValidDirectory(directory),
    })));
    return valid.filter((item) => item.valid).map((item) => item.directory).slice(0, 5);
  }

  private async validRememberedDirectory(conversation: ConversationRow): Promise<string | null> {
    const candidates = await this.recentProjectDirectories(conversation.id);
    const remembered = candidates[0];
    return remembered === conversation.latestProjectDirectory ? remembered : null;
  }

  private async getDocumentRow(documentId: string, workspaceId: string) {
    const [row] = await this.db.select({ document: agentTeamDocuments })
      .from(agentTeamDocuments)
      .innerJoin(agentTeamRuns, eq(agentTeamRuns.id, agentTeamDocuments.runId))
      .where(and(
        eq(agentTeamDocuments.id, documentId),
        eq(agentTeamDocuments.workspaceId, workspaceId),
        eq(agentTeamRuns.workspaceId, workspaceId),
      ))
      .limit(1);
    if (!row) throw new NotFoundException('Agent Team document not found.');
    return row.document;
  }

  private publish(events: readonly AgentTeamConversationEvent[]): void {
    if (events.length === 0) return;
    for (const listener of this.listeners) {
      for (const event of events) listener(event);
    }
  }
}

async function intakeIdForRun(
  conversationId: string,
  runId: string,
  db: Database | ConversationDatabaseTransaction,
): Promise<string | null> {
  const [row] = db.select({ id: agentTeamIntakes.id })
    .from(agentTeamIntakes)
    .where(and(
      eq(agentTeamIntakes.conversationId, conversationId),
      eq(agentTeamIntakes.runId, runId),
    ))
    .limit(1).all();
  return row?.id ?? null;
}

async function retryableTaskKeysForRun(runId: string, db: Database): Promise<string[]> {
  const tasks = await db.select({ taskKey: agentTeamTaskAttempts.taskKey })
    .from(agentTeamTaskAttempts)
    .where(and(
      eq(agentTeamTaskAttempts.runId, runId),
      eq(agentTeamTaskAttempts.status, 'failed'),
      eq(agentTeamTaskAttempts.active, true),
    ))
    .orderBy(asc(agentTeamTaskAttempts.createdAt), desc(agentTeamTaskAttempts.attemptIndex));
  return [...new Set(tasks.map((task) => task.taskKey))];
}

function nextMessageSequence(
  db: Database | ConversationDatabaseTransaction,
  conversationId: string,
): number {
  const [latest] = db.select({ sequence: agentTeamConversationMessages.sequence })
    .from(agentTeamConversationMessages)
    .where(eq(agentTeamConversationMessages.conversationId, conversationId))
    .orderBy(desc(agentTeamConversationMessages.sequence))
    .limit(1).all();
  return (latest?.sequence ?? 0) + 1;
}

function insertConversationEvent(
  db: Database | ConversationDatabaseTransaction,
  conversationId: string,
  type: AgentTeamConversationEventType,
  payload: unknown,
  createdAt: Date,
): AgentTeamConversationEvent {
  const [latest] = db.select({ sequence: agentTeamConversationEvents.sequence })
    .from(agentTeamConversationEvents)
    .where(eq(agentTeamConversationEvents.conversationId, conversationId))
    .orderBy(desc(agentTeamConversationEvents.sequence))
    .limit(1).all();
  const sequence = (latest?.sequence ?? 0) + 1;
  db.insert(agentTeamConversationEvents).values({
    conversationId,
    sequence,
    type,
    payload,
    createdAt,
  }).run();
  return {
    conversationId,
    sequence,
    type,
    payload,
    createdAt: createdAt.toISOString(),
  };
}

function validateSubmissionId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new BadRequestException('A stable conversation submission id is required.');
  }
  return value;
}

function validateMentions(value: unknown): boolean {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return false;
  if (!Array.isArray(value) || value.some((item) => item !== 'coordinator')) {
    throw new BadRequestException('Only the Coordinator mention is supported.');
  }
  return true;
}

function assertSameSubmission(
  message: MessageRow,
  text: string,
  mentionsCoordinator: boolean,
  authorizedCommands: string[],
): void {
  const payload = message.payload as {
    text?: unknown;
    mentions?: unknown;
    authorizedCommands?: unknown;
  };
  if (message.kind !== 'task_request' && message.kind !== 'note' && message.kind !== 'run_answer' && message.kind !== 'answer') return;
  const storedCommands = message.kind === 'run_answer' && Array.isArray(payload.authorizedCommands)
    ? normalizeCommands(payload.authorizedCommands)
    : [];
  if (
    payload?.text !== text
    || Boolean(payload?.mentions) !== mentionsCoordinator
    || (message.kind === 'run_answer' && !sameCommands(storedCommands, authorizedCommands))
  ) {
    throw new BadRequestException('The submission id was already used with different content.');
  }
}

function sameCommands(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((command, index) => command === right[index]);
}

async function pendingInputStatus(db: Database, pendingInputId: string): Promise<string | null> {
  const [row] = await db.select({ status: agentTeamPendingInputs.status })
    .from(agentTeamPendingInputs)
    .where(eq(agentTeamPendingInputs.id, pendingInputId))
    .limit(1);
  return row?.status ?? null;
}

async function findMessageBySubmission(db: Database, conversationId: string, submissionId: string): Promise<MessageRow | null> {
  const [message] = await db.select().from(agentTeamConversationMessages)
    .where(and(
      eq(agentTeamConversationMessages.conversationId, conversationId),
      eq(agentTeamConversationMessages.deduplicationKey, `send:${submissionId}`),
    ))
    .limit(1);
  return message ?? null;
}

function normalizeCommands(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BadRequestException('Authorized commands must be an array.');
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new BadRequestException('Authorized commands must contain non-empty strings.');
    }
    return item.trim();
  });
}

function parseTaskRequest(text: string): {
  goal: string | null;
  projectDirectory: string | null;
  mode: AgentTeamMode | null;
} {
  const withoutMention = text.replace(/^@Coordinator\b\s*/i, '').trim();
  const directory = extractDirectory(withoutMention);
  const goal = withoutMention.replace(directory?.raw ?? '', '').replace(/\s+/g, ' ').trim();
  return {
    goal: goal || null,
    projectDirectory: directory?.value ?? null,
    mode: parseMode(withoutMention),
  };
}

function extractDirectory(text: string): { value: string; raw: string } | null {
  const labeled = text.match(/(?:directory|path|项目目录|目录|路径)\s*[:：]?\s*(\/[^\s，,；;（）]+)/i);
  const raw = labeled?.[1] ?? text.match(/(^|\s)(\/[^\s，,；;（）]+)/)?.[2] ?? null;
  return raw && isAbsolute(raw) ? { value: resolve(raw), raw } : null;
}

function parseMode(text: string): AgentTeamMode | null {
  const value = text.trim().toLowerCase();
  const explicitMode = value.match(/\b(plan_only|implement_and_validate|validate_existing)\b/)?.[1];
  if (explicitMode) return explicitMode as AgentTeamMode;
  if (/\b(plan|planning)\b|规划|计划/.test(value)) return 'plan_only';
  if (/\b(implement|fix|build)\b|实现|修复|开发/.test(value)) return 'implement_and_validate';
  if (/\b(check|validate|verify)\b|验证|检查/.test(value)) return 'validate_existing';
  if (MODES.includes(value as AgentTeamMode)) return value as AgentTeamMode;
  return null;
}

async function parseIntakeAnswer(field: IntakeField, text: string): Promise<string> {
  if (field === 'goal') return text;
  if (field === 'mode') {
    const mode = parseMode(text);
    if (!mode) throw new BadRequestException('A supported Agent Team mode is required.');
    return mode;
  }
  const directory = extractDirectory(text);
  if (!directory) throw new BadRequestException('An absolute local project directory is required.');
  return validateProjectDirectory(directory.value);
}

async function validateProjectDirectory(value: string): Promise<string> {
  if (!isAbsolute(value)) throw new BadRequestException('An absolute local project directory is required.');
  const resolved = resolve(value);
  if (!(await isValidDirectory(resolved))) {
    throw new BadRequestException('The local project directory does not exist on the API host.');
  }
  return resolved;
}

async function isValidDirectory(value: string | null): Promise<boolean> {
  if (!value || !isAbsolute(value)) return false;
  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}

function firstMissingField(
  goal: string | null,
  projectDirectory: string | null,
  mode: AgentTeamMode | null,
): IntakeField | null {
  if (!goal) return 'goal';
  if (!projectDirectory) return 'projectDirectory';
  if (!mode) return 'mode';
  return null;
}

function intakeQuestion(field: IntakeField): string {
  if (field === 'goal') return 'What outcome should the Team deliver?';
  if (field === 'projectDirectory') return 'Which local project directory should the Team use?';
  return 'Which execution mode should this task use?';
}

function outcomeSummary(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const summary = (value as { summary?: unknown }).summary;
  return typeof summary === 'string' ? summary : null;
}

function isTerminalRunStatus(value: unknown): value is AgentTeamRunStatus {
  return value === 'succeeded' || value === 'failed' || value === 'cancelled';
}

function isRunStatus(value: unknown): value is AgentTeamRunStatus {
  return value === 'queued'
    || value === 'running'
    || value === 'waiting_for_input'
    || value === 'paused'
    || value === 'succeeded'
    || value === 'failed'
    || value === 'cancelled';
}

function toMessageView(row: MessageRow): AgentTeamConversationMessage {
  const common = {
    id: row.id,
    conversationId: row.conversationId,
    sequence: row.sequence,
    intakeId: row.intakeId,
    runId: row.runId,
    createdAt: row.createdAt.toISOString(),
  };
  const payload = row.payload as Record<string, unknown>;
  switch (row.kind) {
    case 'task_request':
      return { ...common, speaker: 'user', kind: 'task_request', text: String(payload.text ?? '') };
    case 'coordinator_question':
      return {
        ...common,
        speaker: 'coordinator',
        kind: 'coordinator_question',
        field: payload.field as IntakeField,
        text: String(payload.text ?? ''),
        options: Array.isArray(payload.options) ? payload.options as Array<{ value: string; label: string }> : [],
      };
    case 'answer':
      return {
        ...common,
        speaker: 'user',
        kind: 'answer',
        field: payload.field as IntakeField,
        text: String(payload.text ?? ''),
      };
    case 'run_answer':
      return {
        ...common,
        speaker: 'user',
        kind: 'run_answer',
        pendingInputId: String(payload.pendingInputId ?? ''),
        scopeRevision: Number(payload.scopeRevision ?? 0),
        text: String(payload.text ?? ''),
        authorizedCommands: Array.isArray(payload.authorizedCommands) ? payload.authorizedCommands as string[] : [],
      };
    case 'note':
      return { ...common, speaker: 'user', kind: 'note', text: String(payload.text ?? '') };
    case 'member_question':
      return {
        ...common,
        speaker: 'member',
        kind: 'member_question',
        role: payload.role as AgentTeamRole,
        taskKey: typeof payload.taskKey === 'string' ? payload.taskKey : null,
        developerId: typeof payload.developerId === 'string' ? payload.developerId : null,
        assignmentTitle: typeof payload.assignmentTitle === 'string' ? payload.assignmentTitle : null,
        pendingInputId: String(payload.pendingInputId ?? ''),
        scopeRevision: Number(payload.scopeRevision ?? 0),
        kindDetail: payload.kindDetail === 'operation_recovery' ? 'operation_recovery' : 'question',
        text: String(payload.text ?? ''),
        operationKey: typeof payload.operationKey === 'string' ? payload.operationKey : null,
      };
    case 'status':
      return { ...common, speaker: 'system', kind: 'status', text: String(payload.text ?? '') };
    case 'file_delivery':
      return {
        ...common,
        speaker: 'member',
        kind: 'file_delivery',
        document: payload.document as AgentTeamConversationDocument,
      };
    case 'delivery_failed':
      return {
        ...common,
        speaker: 'system',
        kind: 'delivery_failed',
        document: payload.document as AgentTeamConversationDocument,
        error: String(payload.error ?? ''),
      };
    case 'run_state':
      return {
        ...common,
        speaker: 'system',
        kind: 'run_state',
        status: payload.status as AgentTeamRunStatus,
        taskStatus: (payload.taskStatus ?? null) as AgentTeamTaskAttemptStatus | null,
        role: (payload.role ?? null) as AgentTeamRole | null,
        taskKey: typeof payload.taskKey === 'string' ? payload.taskKey : null,
        developerId: typeof payload.developerId === 'string' ? payload.developerId : null,
        assignmentTitle: typeof payload.assignmentTitle === 'string' ? payload.assignmentTitle : null,
        outcomeSummary: typeof payload.outcomeSummary === 'string' ? payload.outcomeSummary : null,
      };
  }
}

function toIntakeView(row: IntakeRow): AgentTeamConversationIntakeView {
  return {
    id: row.id,
    submissionId: row.submissionId,
    goal: row.goal,
    projectDirectory: row.projectDirectory,
    mode: row.mode,
    unresolvedField: row.unresolvedField,
    status: row.status,
    runId: row.runId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toConversationEventView(row: typeof agentTeamConversationEvents.$inferSelect): AgentTeamConversationEvent {
  return {
    conversationId: row.conversationId,
    sequence: row.sequence,
    type: row.type,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  };
}

function toConversationDocument(
  row: typeof agentTeamDocuments.$inferSelect,
  task: typeof agentTeamTaskAttempts.$inferSelect | null,
): AgentTeamConversationDocument {
  return {
    id: row.id,
    runId: row.runId,
    taskAttemptId: row.taskAttemptId,
    taskKey: task?.taskKey ?? null,
    role: task?.role ?? null,
    key: row.key,
    revision: row.revision,
    title: row.title,
    fileName: agentTeamDocumentFileName(row.key, row.revision),
  };
}

function toDocumentView(row: typeof agentTeamDocuments.$inferSelect): AgentTeamDocumentView {
  return {
    id: row.id,
    runId: row.runId,
    taskAttemptId: row.taskAttemptId,
    key: row.key,
    revision: row.revision,
    title: row.title,
    content: row.content,
    upstreamDocumentKeys: row.upstreamDocumentKeys,
    deliveryStatus: row.deliveryStatus,
    deliveryError: row.deliveryError,
    fileName: agentTeamDocumentFileName(row.key, row.revision),
    createdAt: row.createdAt.toISOString(),
  };
}
