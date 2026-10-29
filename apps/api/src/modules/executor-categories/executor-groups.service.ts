import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import type { Request } from 'express';
import type {
  AgentTeamGroupEvent,
  AgentTeamGroupControlRequest,
  AgentTeamGroupMessage,
  AgentTeamGroupView,
  AgentTeamMemoryView,
  AgentTeamRoleId,
  CreateAgentTeamMemoryRequest,
  UpdateAgentTeamMemoryRequest,
} from '@worklite/contracts';
import {
  executorGroupEvents,
  executorGroupMessages,
  executorGroupRepositories,
  executorGroups,
  executorCategoryMemories,
  executorCategoryRepositories,
  executorPendingInputs,
  executorRuns,
  executorCategories,
  chatSubmissions,
  type Database,
  type StoredAgentTeamRole,
} from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { isValidAgentTeamRoleId, teamEntryRole } from './agent-team-configuration';
import { AgentTeamRuntimeService } from './agent-team-runtime.service';

@Injectable()
export class AgentTeamGroupsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly runtime: AgentTeamRuntimeService,
  ) {}

  async dispatchFromChat(
    request: Request,
    workspaceSlug: string,
    executorCategoryId: string,
    input: { message: string; projectDirectory: string; role?: AgentTeamRoleId; submissionId: string; runId: string },
    acceptance: Parameters<AgentTeamRuntimeService['createGroupRun']>[2],
  ): Promise<AgentTeamGroupView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const team = await this.getTeam(executorCategoryId, workspace.id);
    const digest = createHash('sha256').update(`${workspace.id}:${input.submissionId}`).digest('hex');
    const groupId = `atgroup_chat_${digest}`;
    const now = new Date();
    await this.db.insert(executorGroups).values({
      id: groupId,
      workspaceId: workspace.id,
      executorCategoryId,
      title: input.message.trim().slice(0, 96),
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
    const group = await this.getGroup(groupId, workspace.id);
    if (group.executorCategoryId !== executorCategoryId) throw new ConflictException('The Chat submission group id is already in use.');
    const repositoryView = await this.addRepositories(request, workspaceSlug, groupId, {
      repositories: [{ directory: input.projectDirectory }],
    });
    const repository = repositoryView.repositories.find((item) => item.directory === resolve(input.projectDirectory));
    if (!repository) throw new BadRequestException('The Chat project directory was not attached to its task group.');
    return this.sendMessage(request, workspaceSlug, groupId, {
      body: input.message,
      // Determine entry role from team's actual roles. If user specified a role, use that.
      // Otherwise, resolve to the team's entry role (Dispatcher if present, else Planner).
      recipientRole: input.role ?? teamEntryRole(team),
      repositoryIds: [repository.id],
      submissionId: `chat_${input.submissionId}`,
    }, acceptance);
  }

  async get(request: Request, workspaceSlug: string, groupId: string): Promise<AgentTeamGroupView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const group = await this.getGroup(groupId, workspace.id);
    const [team, repositories, messages, runs] = await Promise.all([
      this.getTeam(group.executorCategoryId, workspace.id),
      this.db.select().from(executorGroupRepositories).where(eq(executorGroupRepositories.groupId, group.id)).orderBy(asc(executorGroupRepositories.createdAt)),
      this.db.select().from(executorGroupMessages).where(eq(executorGroupMessages.groupId, group.id)).orderBy(asc(executorGroupMessages.sequence)),
      this.db.select().from(executorRuns).where(eq(executorRuns.groupId, group.id)).orderBy(asc(executorRuns.createdAt)),
    ]);
    const pendingRows = runs.length ? await this.db.select().from(executorPendingInputs)
      .where(and(inArray(executorPendingInputs.runId, runs.map((run) => run.id)), eq(executorPendingInputs.status, 'pending'), eq(executorPendingInputs.kind, 'question')))
      .orderBy(asc(executorPendingInputs.createdAt)) : [];
    const pendingByRun = new Map<string, typeof pendingRows>();
    for (const pending of pendingRows) pendingByRun.set(pending.runId, [...(pendingByRun.get(pending.runId) ?? []), pending]);
    const convertedMessages = messages.map(toMessageView);
    return {
      id: group.id,
      executorCategoryId: group.executorCategoryId,
      title: group.title,
      mode: group.mode,
      status: runs.length ? runs.at(-1)!.status : 'empty',
      runCount: runs.length,
      repositories: repositories.map(toRepositoryView),
      lastMessage: convertedMessages.at(-1) ?? null,
      createdAt: group.createdAt.toISOString(),
      updatedAt: group.updatedAt.toISOString(),
      workingPractice: team.workingPractice,
      messages: convertedMessages,
      runs: runs.map((run) => ({
        id: run.id,
        targetRole: run.targetRole,
        currentRole: (() => {
          const lastMessage = [...convertedMessages].reverse().find((message) => message.runId === run.id);
          return lastMessage?.recipientRole ?? lastMessage?.senderRole ?? run.targetRole;
        })(),
        status: run.status,
        intent: run.intent,
        repositoryIds: run.repositoryIds,
        createdAt: run.createdAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
        pendingInputs: (pendingByRun.get(run.id) ?? []).map((input) => ({ id: input.id, question: input.question, scopeRevision: input.scopeRevision })),
      })),
    };
  }

  private async addRepositories(request: Request, workspaceSlug: string, groupId: string, input: { repositories: Array<{ name?: string; directory: string }> }) {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const group = await this.getGroup(groupId, workspace.id);
    if (!Array.isArray(input?.repositories) || input.repositories.length === 0) {
      throw new BadRequestException('At least one repository directory is required.');
    }
    const prepared: Array<{ directory: string; name: string }> = [];
    for (const candidate of input.repositories) {
      if (typeof candidate?.directory !== 'string' || !isAbsolute(candidate.directory.trim())) {
        throw new BadRequestException('Repository directories must be absolute paths.');
      }
      const directory = resolve(candidate.directory.trim());
      let info;
      try { info = await stat(directory); } catch { throw new BadRequestException(`Repository directory does not exist: ${directory}`); }
      if (!info.isDirectory()) throw new BadRequestException(`Repository path is not a directory: ${directory}`);
      prepared.push({ directory, name: candidate.name?.trim() || basename(directory) || directory });
    }
    await this.db.transaction((transaction) => {
      const now = new Date();
      for (const repository of prepared) {
        const [existing] = transaction.select({ id: executorGroupRepositories.id })
          .from(executorGroupRepositories)
          .where(and(eq(executorGroupRepositories.groupId, group.id), eq(executorGroupRepositories.directory, repository.directory)))
          .limit(1).all();
        if (existing) continue;
        const [teamRepository] = transaction.select({ id: executorCategoryRepositories.id })
          .from(executorCategoryRepositories)
          .where(and(eq(executorCategoryRepositories.executorCategoryId, group.executorCategoryId), eq(executorCategoryRepositories.directory, repository.directory)))
          .limit(1).all();
        const teamRepositoryId = teamRepository?.id ?? `atrepo_${createHash('sha256').update(`${group.executorCategoryId}:${repository.directory}`).digest('hex')}`;
        if (!teamRepository) transaction.insert(executorCategoryRepositories).values({
          id: teamRepositoryId,
          workspaceId: workspace.id,
          executorCategoryId: group.executorCategoryId,
          name: repository.name,
          directory: repository.directory,
          createdAt: now,
          updatedAt: now,
        }).run();
        transaction.insert(executorGroupRepositories).values({
          id: `atrepo_${randomUUID()}`,
          workspaceId: workspace.id,
          groupId: group.id,
          teamRepositoryId,
          name: repository.name,
          directory: repository.directory,
          createdAt: now,
        }).run();
      }
      this.appendGroupEvent(transaction, group.id, 'repository.updated', { repositories: prepared });
      transaction.update(executorGroups).set({ updatedAt: now }).where(eq(executorGroups.id, group.id)).run();
    });
    return this.get(request, workspaceSlug, groupId);
  }

  private async sendMessage(
    request: Request,
    workspaceSlug: string,
    groupId: string,
    input: { body: string; recipientRole: AgentTeamRoleId; repositoryIds?: string[]; submissionId: string },
    acceptance?: Parameters<AgentTeamRuntimeService['createGroupRun']>[2],
  ): Promise<AgentTeamGroupView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const group = await this.getGroup(groupId, workspace.id);
    const body = input?.body?.trim();
    if (!body) throw new BadRequestException('A group message is required.');
    const recipientRole = this.requireRole(input?.recipientRole);
    const team = await this.getTeam(group.executorCategoryId, workspace.id);
    if (!team.roles.some((role) => role.role === recipientRole)) throw new BadRequestException('Select an active role in this Coding Executors team.');
    const submissionId = input?.submissionId?.trim();
    if (!submissionId) throw new BadRequestException('A message submission id is required.');
    const repositories = await this.db.select().from(executorGroupRepositories)
      .where(eq(executorGroupRepositories.groupId, group.id)).orderBy(asc(executorGroupRepositories.createdAt));
    const requestedIds = input.repositoryIds?.length ? [...new Set(input.repositoryIds)] : repositories.map((repo) => repo.id);
    const selectedRepositories = repositories.filter((repo) => requestedIds.includes(repo.id));
    if (selectedRepositories.length !== requestedIds.length) throw new BadRequestException('Select repositories that belong to this task group.');

    const existing = await this.db.select().from(executorGroupMessages)
      .where(and(eq(executorGroupMessages.groupId, group.id), eq(executorGroupMessages.submissionId, submissionId))).limit(1);
    if (existing[0]?.runId) return this.get(request, workspaceSlug, groupId);
    const messageId = existing[0]?.id ?? `atmsg_${randomUUID()}`;
    // A message never fails for missing repositories: an unscoped message creates an
    // empty-scope Run, and the addressed role identifies or asks for the directory.
    if (!existing.length) await this.db.transaction((transaction) => {
      this.insertMessage(transaction, {
        id: messageId,
        workspaceId: workspace.id,
        groupId: group.id,
        sender: 'user',
        recipientRole,
        kind: 'text',
        body,
        repositoryIds: requestedIds,
        submissionId,
        deliveryStatus: 'pending',
      });
      if (group.title.trim() === '') {
        transaction.update(executorGroups).set({ title: body.slice(0, 96), updatedAt: new Date() })
          .where(eq(executorGroups.id, group.id)).run();
      }
    });

    const contextRepositories = await Promise.all(selectedRepositories.map(async (repository) => ({
      id: repository.id,
      memoryRepositoryId: repository.teamRepositoryId,
      name: repository.name,
      directory: repository.directory,
      projectInstructions: await this.runtime.readGroupProjectInstructions(repository.directory),
    })));
    const memories = await this.db.select().from(executorCategoryMemories)
      .where(and(eq(executorCategoryMemories.executorCategoryId, group.executorCategoryId), eq(executorCategoryMemories.workspaceId, workspace.id)))
      .orderBy(desc(executorCategoryMemories.updatedAt));
    // An empty-scope Run captures the Team's known repositories as identification
    // candidates so the role can recognize the project directory on its own.
    const knownRepositories = contextRepositories.length === 0
      ? await this.db.select({ name: executorCategoryRepositories.name, directory: executorCategoryRepositories.directory })
        .from(executorCategoryRepositories)
        .where(and(eq(executorCategoryRepositories.executorCategoryId, group.executorCategoryId), eq(executorCategoryRepositories.workspaceId, workspace.id)))
        .orderBy(asc(executorCategoryRepositories.name))
      : [];
    const groupContext: NonNullable<import('@worklite/db').AgentTeamRun['groupContext']> = {
      groupId: group.id,
      initialMessageId: messageId,
      initialMessage: body,
      targetRole: recipientRole as StoredAgentTeamRole,
      mode: group.mode,
      repositories: contextRepositories,
      ...(knownRepositories.length ? { knownRepositories } : {}),
      memories: memories.filter((memory) => !memory.repositoryId || selectedRepositories.some((repository) => repository.teamRepositoryId === memory.repositoryId)).map((memory) => ({
        id: memory.id,
        repositoryId: memory.repositoryId,
        role: memory.role,
        content: memory.content,
      })),
    };
    const runId = acceptance?.runId ?? `atrun_${randomUUID()}`;
    try {
      await this.runtime.createGroupRun(workspace.id, {
        executorCategoryId: group.executorCategoryId,
        groupId: group.id,
        groupMessageId: messageId,
        targetRole: recipientRole as StoredAgentTeamRole,
        repositoryIds: requestedIds,
        intent: body,
        groupContext,
      }, {
        runId,
        accept: (transaction, acceptedRunId) => {
          transaction.update(executorGroupMessages).set({ runId: acceptedRunId, deliveryStatus: 'delivered' })
            .where(eq(executorGroupMessages.id, messageId)).run();
          this.appendGroupEvent(transaction, group.id, 'run.updated', { runId: acceptedRunId, status: 'queued' });
          acceptance?.accept(transaction, acceptedRunId);
        },
      });
    } catch (error) {
      await this.db.transaction((transaction) => {
        transaction.update(executorGroupMessages).set({ deliveryStatus: 'failed' }).where(eq(executorGroupMessages.id, messageId)).run();
        this.insertMessage(transaction, {
          workspaceId: workspace.id,
          groupId: group.id,
          sender: 'system',
          kind: 'status',
          body: error instanceof Error ? error.message : '无法启动角色任务。',
          deliveryStatus: 'delivered',
        });
      });
      throw error;
    }
    return this.get(request, workspaceSlug, groupId);
  }

  async events(request: Request, workspaceSlug: string, groupId: string, afterSequence = 0): Promise<AgentTeamGroupEvent[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.getGroup(groupId, workspace.id);
    const rows = await this.db.select().from(executorGroupEvents)
      .where(and(eq(executorGroupEvents.groupId, groupId), gt(executorGroupEvents.sequence, afterSequence)))
      .orderBy(asc(executorGroupEvents.sequence));
    return rows.map((row) => ({
      groupId: row.groupId,
      sequence: row.sequence,
      type: row.type,
      payload: row.payload,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async control(request: Request, workspaceSlug: string, groupId: string, input: AgentTeamGroupControlRequest) {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const group = await this.getGroup(groupId, workspace.id);
    const team = await this.getTeam(group.executorCategoryId, workspace.id);
    if (input?.operation !== 'reexecute') throw new BadRequestException('Only Chat re-execution is available for Coding Executors team groups.');
    const runIds = [...new Set(input?.runIds ?? [])];
    if (!runIds.length) throw new BadRequestException('Select at least one Run to re-execute.');
    const runs = await this.db.select().from(executorRuns)
      .where(and(eq(executorRuns.groupId, group.id), eq(executorRuns.workspaceId, workspace.id), inArray(executorRuns.id, runIds)));
    if (runs.length !== runIds.length) throw new BadRequestException('A selected Run does not belong to this group.');
    for (const run of runs) {
      if (!run.targetRole || !run.groupMessageId) throw new BadRequestException('The selected Run has no re-executable group message.');
      const [message] = await this.db.select().from(executorGroupMessages).where(eq(executorGroupMessages.id, run.groupMessageId)).limit(1);
      if (!message) throw new NotFoundException('The original group message was not found.');
      // If the original targetRole is executor-manager or no longer exists in the team,
      // fall back to the team's current entry role.
      let initialRole = run.targetRole as AgentTeamRoleId;
      if (initialRole === 'executor-manager' || !team.roles.some((r) => r.role === initialRole)) {
        initialRole = teamEntryRole(team);
      }
      const submissionId = `reexecute_${run.id}_${randomUUID()}`;
      // A Run bound to a Chat conversation keeps its replacement in that conversation: the new
      // Run gets its own task submission, so its card, pin, progress and terminal report follow it.
      const [binding] = await this.db.select().from(chatSubmissions)
        .where(and(eq(chatSubmissions.workspaceId, workspace.id), sql`json_extract(${chatSubmissions.reference}, '$.kind') = 'executor_category'`, sql`json_extract(${chatSubmissions.reference}, '$.runId') = ${run.id}`))
        .limit(1);
      const reference = binding?.reference?.kind === 'executor_category' ? binding.reference : null;
      await this.sendMessage(request, workspaceSlug, groupId, {
        body: message.body,
        recipientRole: initialRole,
        repositoryIds: run.repositoryIds,
        submissionId,
      }, binding && reference ? {
        runId: `atrun_${randomUUID()}`,
        accept: (transaction, acceptedRunId) => {
          transaction.insert(chatSubmissions).values({
            id: submissionId,
            workspaceId: binding.workspaceId,
            chatId: binding.chatId,
            executionId: binding.executionId,
            message: binding.message,
            target: binding.target,
            reference: { ...reference, runId: acceptedRunId },
          }).run();
        },
      } : undefined);
    }
    await this.db.transaction((transaction) => {
      for (const run of runs) {
        this.insertMessage(transaction, {
          workspaceId: workspace.id,
          groupId: group.id,
          sender: 'user',
          recipientRole: run.targetRole ?? undefined,
          kind: 'control',
          body: `Chat 重新执行 ${run.id}`,
          runId: run.id,
          repositoryIds: run.repositoryIds,
          deliveryStatus: 'delivered',
        });
      }
    });
    return this.get(request, workspaceSlug, groupId);
  }

  async memories(request: Request, workspaceSlug: string, executorCategoryId: string): Promise<AgentTeamMemoryView[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.getTeam(executorCategoryId, workspace.id);
    const rows = await this.db.select({ memory: executorCategoryMemories, repositoryName: executorCategoryRepositories.name, repositoryDirectory: executorCategoryRepositories.directory }).from(executorCategoryMemories)
      .leftJoin(executorCategoryRepositories, eq(executorCategoryRepositories.id, executorCategoryMemories.repositoryId))
      .where(and(eq(executorCategoryMemories.executorCategoryId, executorCategoryId), eq(executorCategoryMemories.workspaceId, workspace.id)))
      .orderBy(desc(executorCategoryMemories.updatedAt));
    return rows.map((row) => toMemoryView(row.memory, row.repositoryName ?? null, row.repositoryDirectory ?? null));
  }

  private async assertMemoryScope(workspaceId: string, executorCategoryId: string, repositoryId: string | null | undefined): Promise<void> {
    if (!repositoryId) return;
    const [repository] = await this.db.select({ id: executorCategoryRepositories.id }).from(executorCategoryRepositories)
      .where(and(eq(executorCategoryRepositories.id, repositoryId), eq(executorCategoryRepositories.executorCategoryId, executorCategoryId), eq(executorCategoryRepositories.workspaceId, workspaceId))).limit(1);
    if (!repository) throw new BadRequestException('The memory repository is not available for this Coding Executors team.');
  }

  private async assertMemorySource(workspaceId: string, executorCategoryId: string, sourceMessageId: string | null | undefined): Promise<void> {
    if (!sourceMessageId) return;
    const [message] = await this.db.select({ id: executorGroupMessages.id }).from(executorGroupMessages)
      .innerJoin(executorGroups, eq(executorGroups.id, executorGroupMessages.groupId))
      .where(and(
        eq(executorGroupMessages.id, sourceMessageId),
        eq(executorGroupMessages.workspaceId, workspaceId),
        eq(executorGroups.executorCategoryId, executorCategoryId),
      )).limit(1);
    if (!message) throw new BadRequestException('The memory source must be a message from this Coding Executors team.');
  }

  async createMemory(request: Request, workspaceSlug: string, executorCategoryId: string, input: CreateAgentTeamMemoryRequest): Promise<AgentTeamMemoryView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.getTeam(executorCategoryId, workspace.id);
    const content = input?.content?.trim();
    if (!content) throw new BadRequestException('Memory content is required.');
    const role = input.role ? this.requireRole(input.role) : null;
    await this.assertMemoryScope(workspace.id, executorCategoryId, input.repositoryId);
    await this.assertMemorySource(workspace.id, executorCategoryId, input.sourceMessageId);
    const now = new Date();
    const [row] = await this.db.insert(executorCategoryMemories).values({
      id: `atmemory_${randomUUID()}`,
      workspaceId: workspace.id,
      executorCategoryId,
      repositoryId: input.repositoryId ?? null,
      role: role as StoredAgentTeamRole | null,
      content,
      sourceMessageId: input.sourceMessageId ?? null,
      createdAt: now,
      updatedAt: now,
    }).returning();
    const [repository] = row!.repositoryId
      ? await this.db.select({ name: executorCategoryRepositories.name, directory: executorCategoryRepositories.directory }).from(executorCategoryRepositories).where(eq(executorCategoryRepositories.id, row!.repositoryId)).limit(1)
      : [];
    return toMemoryView(row!, repository?.name ?? null, repository?.directory ?? null);
  }

  async updateMemory(request: Request, workspaceSlug: string, executorCategoryId: string, memoryId: string, input: UpdateAgentTeamMemoryRequest): Promise<AgentTeamMemoryView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.getTeam(executorCategoryId, workspace.id);
    const [existing] = await this.db.select().from(executorCategoryMemories)
      .where(and(eq(executorCategoryMemories.id, memoryId), eq(executorCategoryMemories.executorCategoryId, executorCategoryId), eq(executorCategoryMemories.workspaceId, workspace.id))).limit(1);
    if (!existing) throw new NotFoundException('Coding Executors team memory not found.');
    const content = input.content === undefined ? existing.content : input.content.trim();
    if (!content) throw new BadRequestException('Memory content is required.');
    await this.assertMemoryScope(workspace.id, executorCategoryId, input.repositoryId === undefined ? existing.repositoryId : input.repositoryId);
    await this.assertMemorySource(workspace.id, executorCategoryId, input.sourceMessageId === undefined ? existing.sourceMessageId : input.sourceMessageId);
    const [updated] = await this.db.update(executorCategoryMemories).set({
      content,
      repositoryId: input.repositoryId === undefined ? existing.repositoryId : input.repositoryId,
      role: input.role === undefined ? existing.role : (input.role ? this.requireRole(input.role) as StoredAgentTeamRole : null),
      sourceMessageId: input.sourceMessageId === undefined ? existing.sourceMessageId : input.sourceMessageId,
      updatedAt: new Date(),
    }).where(eq(executorCategoryMemories.id, memoryId)).returning();
    const [repository] = updated!.repositoryId
      ? await this.db.select({ name: executorCategoryRepositories.name, directory: executorCategoryRepositories.directory }).from(executorCategoryRepositories).where(eq(executorCategoryRepositories.id, updated!.repositoryId)).limit(1)
      : [];
    return toMemoryView(updated!, repository?.name ?? null, repository?.directory ?? null);
  }

  async deleteMemory(request: Request, workspaceSlug: string, executorCategoryId: string, memoryId: string): Promise<void> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.getTeam(executorCategoryId, workspace.id);
    const deleted = await this.db.delete(executorCategoryMemories).where(and(
      eq(executorCategoryMemories.id, memoryId), eq(executorCategoryMemories.executorCategoryId, executorCategoryId), eq(executorCategoryMemories.workspaceId, workspace.id),
    )).returning({ id: executorCategoryMemories.id });
    if (!deleted.length) throw new NotFoundException('Coding Executors team memory not found.');
  }

  private async getGroup(groupId: string, workspaceId: string) {
    const [group] = await this.db.select().from(executorGroups)
      .where(and(eq(executorGroups.id, groupId), eq(executorGroups.workspaceId, workspaceId))).limit(1);
    if (!group) throw new NotFoundException('Coding Executors team group not found.');
    return group;
  }

  private async getTeam(executorCategoryId: string, workspaceId: string) {
    const [team] = await this.db.select().from(executorCategories)
      .where(and(eq(executorCategories.id, executorCategoryId), eq(executorCategories.workspaceId, workspaceId))).limit(1);
    if (!team) throw new NotFoundException('Coding Executors team not found.');
    return team;
  }

  private insertMessage(transaction: Parameters<Parameters<Database['transaction']>[0]>[0], input: {
    id?: string; workspaceId: string; groupId: string; sender: 'user' | 'role' | 'system'; senderRole?: AgentTeamRoleId;
    recipientRole?: AgentTeamRoleId; kind: 'text' | 'question' | 'handoff' | 'control' | 'status' | 'file'; body: string;
    runId?: string; repositoryIds?: string[]; submissionId?: string; deliveryStatus: 'pending' | 'delivered' | 'failed';
  }) {
    const [latest] = transaction.select({ sequence: executorGroupMessages.sequence }).from(executorGroupMessages)
      .where(eq(executorGroupMessages.groupId, input.groupId)).orderBy(desc(executorGroupMessages.sequence)).limit(1).all();
    const [message] = transaction.insert(executorGroupMessages).values({
      id: input.id ?? `atmsg_${randomUUID()}`,
      workspaceId: input.workspaceId,
      groupId: input.groupId,
      sequence: (latest?.sequence ?? 0) + 1,
      sender: input.sender,
      senderRole: input.senderRole as StoredAgentTeamRole | undefined,
      recipientRole: input.recipientRole as StoredAgentTeamRole | undefined,
      kind: input.kind,
      body: input.body,
      runId: input.runId,
      repositoryIds: input.repositoryIds ?? [],
      submissionId: input.submissionId,
      deliveryStatus: input.deliveryStatus,
    }).returning().all();
    this.appendGroupEvent(transaction, input.groupId, 'message', { message });
    transaction.update(executorGroups).set({ updatedAt: new Date() }).where(eq(executorGroups.id, input.groupId)).run();
    return message!;
  }

  private appendGroupEvent(transaction: Parameters<Parameters<Database['transaction']>[0]>[0], groupId: string, type: 'message' | 'repository.updated' | 'run.updated' | 'memory.updated', payload: Record<string, unknown>) {
    const [latest] = transaction.select({ sequence: executorGroupEvents.sequence }).from(executorGroupEvents)
      .where(eq(executorGroupEvents.groupId, groupId)).orderBy(desc(executorGroupEvents.sequence)).limit(1).all();
    transaction.insert(executorGroupEvents).values({ groupId, sequence: (latest?.sequence ?? 0) + 1, type, payload }).run();
  }

  private requireRole(value: unknown): AgentTeamRoleId {
    if (!isValidAgentTeamRoleId(value)) throw new BadRequestException('Select a supported Coding Executors team role.');
    return value;
  }
}

function toRepositoryView(row: typeof executorGroupRepositories.$inferSelect) {
  return { id: row.id, teamRepositoryId: row.teamRepositoryId, name: row.name, directory: row.directory, createdAt: row.createdAt.toISOString() };
}

function toMessageView(row: typeof executorGroupMessages.$inferSelect): AgentTeamGroupMessage {
  return {
    id: row.id,
    sequence: row.sequence,
    sender: row.sender,
    senderRole: row.senderRole,
    recipientRole: row.recipientRole,
    kind: row.kind,
    body: row.body,
    runId: row.runId,
    taskAttemptId: row.taskAttemptId,
    repositoryIds: row.repositoryIds,
    fileReferences: row.fileReferences,
    deliveryStatus: row.deliveryStatus,
    createdAt: row.createdAt.toISOString(),
  };
}

function toMemoryView(row: typeof executorCategoryMemories.$inferSelect, repositoryName: string | null, repositoryDirectory: string | null): AgentTeamMemoryView {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    repositoryName,
    repositoryDirectory,
    role: row.role,
    content: row.content,
    sourceMessageId: row.sourceMessageId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
