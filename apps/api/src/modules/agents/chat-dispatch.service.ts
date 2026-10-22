import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Request } from 'express';
import type { ChatTaskReference, DispatchChatRequest, DispatchChatResponse } from '@worklite/contracts';
import { agentExecutionEvents, agentExecutions, chatSubmissions, workflowVersions, workflows, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { AgentExecutionsService } from './agent-executions.service';
import { AgentTeamGroupsService } from '../agent-teams/agent-team-groups.service';
import { RunsService } from '../runs/runs.service';

export const CHAT_AGENT_ID = 'agt_system_helper_chat';
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
export class ChatDispatchService {
  private readonly logger = new Logger(ChatDispatchService.name);
  private readonly pending = new Map<string, Promise<DispatchChatResponse>>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly executions: AgentExecutionsService,
    private readonly teamGroups: AgentTeamGroupsService,
    private readonly runs: RunsService,
  ) {}

  dispatch(request: Request, input: DispatchChatRequest): Promise<DispatchChatResponse> {
    const current = this.pending.get(input?.submissionId);
    if (current) return current;
    const task = this.accept(request, input).finally(() => this.pending.delete(input.submissionId));
    this.pending.set(input.submissionId, task);
    return task;
  }

  private async accept(request: Request, input: DispatchChatRequest): Promise<DispatchChatResponse> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    if (!input?.submissionId?.trim() || typeof input.message !== 'string' || !input.target) throw new BadRequestException('A stable submission id, message and target are required.');
    if (!['conversation', 'team', 'workflow'].includes(input.target.kind)) throw new BadRequestException('Unknown conversation target.');
    if (input.executionId) {
      const [execution] = await this.db.select({ id: agentExecutions.id }).from(agentExecutions)
        .where(and(eq(agentExecutions.id, input.executionId), eq(agentExecutions.workspaceId, workspace.id), eq(agentExecutions.agentId, CHAT_AGENT_ID))).limit(1);
      if (!execution) throw new NotFoundException('Chat conversation not found.');
    }
    await this.db.insert(chatSubmissions).values({ id: input.submissionId, workspaceId: workspace.id, executionId: input.executionId, message: input.message, target: input.target }).onConflictDoNothing();
    const [submission] = await this.db.select().from(chatSubmissions).where(eq(chatSubmissions.id, input.submissionId)).limit(1);
    if (submission.workspaceId !== workspace.id || submission.message !== input.message || JSON.stringify(submission.target) !== JSON.stringify(input.target)) throw new ConflictException('The submission id already belongs to another request.');
    if (submission.reference) return { submissionId: submission.id, reference: submission.reference };
    const bind = (transaction: Transaction, reference: ChatTaskReference) => {
      transaction.update(chatSubmissions).set({ reference, error: null, updatedAt: new Date() }).where(eq(chatSubmissions.id, submission.id)).run();
    };

    try {
      if (input.target.kind === 'conversation') {
        const current = input.executionId ? await this.executions.get(request, 'personal', CHAT_AGENT_ID, input.executionId) : null;
        const afterMessageId = input.newConversation ? null : current?.messages.at(-1)?.id ?? null;
        const accept = (transaction: Transaction, executionId: string) => {
          // Freeze the previous turn before appending another user message to the same execution.
          if (current) {
            const previous = transaction.select().from(chatSubmissions).where(eq(chatSubmissions.executionId, current.id)).all();
            for (const row of previous) {
              if (row.reference?.kind !== 'conversation' || row.reference.completionStatus) continue;
              transaction.update(chatSubmissions).set({ reference: { ...row.reference, untilMessageId: current.messages.at(-1)?.id ?? null, completionStatus: current.status === 'waiting_for_input' ? 'completed' : current.status, completionError: current.error }, settled: false, deliveryFingerprint: null }).where(eq(chatSubmissions.id, row.id)).run();
            }
          }
          transaction.update(chatSubmissions).set({ executionId }).where(eq(chatSubmissions.id, submission.id)).run();
          const boundary = transaction.select({ sequence: sql<number>`coalesce(max(${agentExecutionEvents.sequence}), 0)` }).from(agentExecutionEvents).where(eq(agentExecutionEvents.executionId, executionId)).get();
          bind(transaction, { kind: 'conversation', executionId, afterMessageId, afterSequence: boundary?.sequence ?? 0 });
        };
        if (input.newConversation) {
          if (!current || !input.questionId) throw new ConflictException('A bound new-conversation question is required.');
          await this.executions.startNewConversation(request, 'personal', current.id, input.questionId, accept);
        }
        else if (!current) await this.executions.create(request, 'personal', CHAT_AGENT_ID, { message: input.message }, accept);
        else if (current.status === 'waiting_for_input' && current.pendingQuestion && input.questionId === current.pendingQuestion.id) await this.executions.answer(request, 'personal', CHAT_AGENT_ID, current.id, { questionId: current.pendingQuestion.id, answer: input.message, recoveryDecision: input.recoveryDecision }, accept);
        else if (current.status === 'waiting_for_input') throw new ConflictException('A pending answer required before queued messages can continue.');
        else await this.executions.continue(request, 'personal', CHAT_AGENT_ID, current.id, { message: input.message }, accept);
      } else if (input.target.kind === 'workflow') {
        const [version] = await this.db.select({ id: workflowVersions.id }).from(workflowVersions)
          .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
          .where(and(eq(workflows.id, input.target.workflowId), eq(workflows.workspaceId, workspace.id), eq(workflowVersions.published, true)))
          .orderBy(desc(workflowVersions.version)).limit(1);
        if (!version) throw new NotFoundException('This Workflow has no published version.');
        const runId = `run_chat_${createHash('sha256').update(workspace.id + ':' + submission.id).digest('hex')}`;
        await this.runs.createForVersion(request, version.id, { input: input.message }, { runId, accept: (transaction) => bind(transaction, { kind: 'workflow', runId, workflowVersionId: version.id }) });
      } else {
        const target = input.target;
        const digest = createHash('sha256').update(workspace.id + ':' + submission.id).digest('hex');
        const runId = `atrun_chat_${digest}`;
        const groupId = `atgroup_chat_${digest}`;
        // Agent Teams decide their own Run mode; older callers may still send one.
        if (target.mode !== undefined) this.logger.warn(`Ignoring deprecated Agent Team mode "${String(target.mode)}" for Chat submission ${submission.id}.`);
        const dispatched = await this.teamGroups.dispatchFromChat(request, 'personal', target.teamId, {
          message: input.message,
          projectDirectory: target.projectDirectory,
          role: target.role,
          submissionId: submission.id,
          runId,
        }, { runId, accept: (transaction, id) => bind(transaction, { kind: 'team', teamId: target.teamId, runId: id, groupId }) });
        if (dispatched.id !== groupId) throw new Error('Chat Team group id did not match its idempotent submission.');
      }
      const [accepted] = await this.db.select().from(chatSubmissions).where(eq(chatSubmissions.id, submission.id)).limit(1);
      if (!accepted.reference) throw new Error('Conversation dispatch did not commit a task reference.');
      return { submissionId: submission.id, reference: accepted.reference };
    } catch (error) {
      const message = error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException
        ? error.message : '任务提交失败，请查看关联执行记录。';
      await this.db.update(chatSubmissions).set({ error: message, updatedAt: new Date() })
        .where(and(eq(chatSubmissions.id, submission.id), isNull(chatSubmissions.reference)));
      throw error;
    }
  }
}
