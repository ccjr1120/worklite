import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Request } from 'express';
import type { AgentSubSessionView, CreateAgentSubSessionRequest, UpdateAgentSubSessionRequest } from '@worklite/contracts';
import { agentExecutions, agents, agentSubSessions, type Database, type StoredAgentDisplayMessage, type StoredAgentModelMessage } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { AgentExecutionsService } from './agent-executions.service';

@Injectable()
export class AgentSubSessionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly executions: AgentExecutionsService,
  ) {}

  async list(request: Request, workspaceSlug: string): Promise<AgentSubSessionView[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = await this.db.select({ session: agentSubSessions, execution: agentExecutions, agentName: agents.name })
      .from(agentSubSessions)
      .innerJoin(agentExecutions, eq(agentSubSessions.executionId, agentExecutions.id))
      .innerJoin(agents, eq(agentSubSessions.agentId, agents.id))
      .where(eq(agentSubSessions.workspaceId, workspace.id))
      .orderBy(desc(agentSubSessions.updatedAt));
    return rows.map(({ session, execution, agentName }) => toView(session, execution.status, agentName));
  }

  async create(request: Request, workspaceSlug: string, input: CreateAgentSubSessionRequest): Promise<AgentSubSessionView> {
    validateCreateInput(input);
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [agent] = await this.db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.workspaceId, workspace.id))).limit(1);
    if (!agent) throw new NotFoundException('Agent not found');
    if (agent.kind !== 'custom') throw new BadRequestException('Only custom Agents can be started as sub-sessions.');
    if (!agent.providerId || !agent.model) throw new ConflictException('Configure a model provider and model before running this Agent.');

    const content = input.message;
    const executionId = `aex_${randomUUID()}`;
    const sessionId = `asub_${randomUUID()}`;
    const now = new Date();
    const createdAt = now.toISOString();
    const modelMessages: StoredAgentModelMessage[] = [{ role: 'user', content }];
    const displayMessages: StoredAgentDisplayMessage[] = [{ id: `msg_${randomUUID()}`, role: 'user', content, createdAt }];
    const title = subSessionTitle(content);

    this.db.transaction((transaction) => {
      transaction.insert(agentExecutions).values({ id: executionId, workspaceId: workspace.id, agentId: agent.id, status: 'running', modelMessages, displayMessages, createdAt: now, updatedAt: now }).run();
      transaction.insert(agentSubSessions).values({ id: sessionId, workspaceId: workspace.id, agentId: agent.id, executionId, title, unread: false, createdAt: now, updatedAt: now }).run();
    });
    this.executions.schedule(request, workspaceSlug, executionId);
    return toView({ id: sessionId, workspaceId: workspace.id, agentId: agent.id, executionId, title, unread: false, createdAt: now, updatedAt: now }, 'running', agent.name);
  }

  async update(request: Request, workspaceSlug: string, sessionId: string, input: UpdateAgentSubSessionRequest): Promise<AgentSubSessionView> {
    validateUpdateInput(input);
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [updated] = await this.db.update(agentSubSessions).set({ unread: input.unread, updatedAt: new Date() })
      .where(and(eq(agentSubSessions.id, sessionId), eq(agentSubSessions.workspaceId, workspace.id)))
      .returning();
    if (!updated) throw new NotFoundException('Agent sub-session not found');
    const [row] = await this.db.select({ status: agentExecutions.status, agentName: agents.name })
      .from(agentExecutions)
      .innerJoin(agents, eq(agentExecutions.agentId, agents.id))
      .where(and(eq(agentExecutions.id, updated.executionId), eq(agentExecutions.workspaceId, workspace.id)))
      .limit(1);
    if (!row) throw new NotFoundException('Agent sub-session execution not found');
    return toView(updated, row.status, row.agentName);
  }

  async delete(request: Request, workspaceSlug: string, sessionId: string): Promise<void> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [session] = await this.db.select().from(agentSubSessions).where(and(eq(agentSubSessions.id, sessionId), eq(agentSubSessions.workspaceId, workspace.id))).limit(1);
    if (!session) throw new NotFoundException('Agent sub-session not found');
    const [execution] = await this.db.select({ status: agentExecutions.status }).from(agentExecutions).where(and(eq(agentExecutions.id, session.executionId), eq(agentExecutions.workspaceId, workspace.id))).limit(1);
    if (execution?.status === 'running') await this.executions.cancel(request, workspaceSlug, session.agentId, session.executionId);
    this.db.transaction((transaction) => {
      transaction.delete(agentSubSessions).where(eq(agentSubSessions.id, session.id)).run();
      transaction.delete(agentExecutions).where(eq(agentExecutions.id, session.executionId)).run();
    });
  }
}

function validateCreateInput(input: CreateAgentSubSessionRequest): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'agentId' && key !== 'message')) throw new BadRequestException('Only agentId and message are accepted.');
  if (typeof input.agentId !== 'string' || !input.agentId.trim()) throw new BadRequestException('An Agent is required.');
  if (typeof input.message !== 'string' || !input.message.trim()) throw new BadRequestException('An Agent task is required.');
}

function validateUpdateInput(input: UpdateAgentSubSessionRequest): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'unread') || typeof input.unread !== 'boolean') throw new BadRequestException('Only a boolean unread state is accepted.');
}

function subSessionTitle(message: string): string {
  const firstLine = message.trim().split(/\r?\n/, 1)[0] ?? '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function initials(name: string): string {
  return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function toView(session: typeof agentSubSessions.$inferSelect, status: AgentSubSessionView['status'], agentName: string): AgentSubSessionView {
  return { id: session.id, agentId: session.agentId, agentName, agentInitials: initials(agentName), executionId: session.executionId, title: session.title, unread: session.unread, status, createdAt: session.createdAt.toISOString(), updatedAt: session.updatedAt.toISOString() };
}
