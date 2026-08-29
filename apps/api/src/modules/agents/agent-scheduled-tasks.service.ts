import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, lte } from 'drizzle-orm';
import type { Request } from 'express';
import type { CreateScheduledAgentTaskRequest, ScheduledAgentTaskView } from '@worklite/contracts';
import { agentExecutions, agents, scheduledAgentTasks, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { AgentExecutionsService } from './agent-executions.service';

@Injectable()
export class AgentScheduledTasksService implements OnModuleInit {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly executions: AgentExecutionsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.runDueTasks(), 10_000);
    this.timer.unref();
    void this.runDueTasks();
  }

  async list(request: Request, workspaceSlug: string): Promise<ScheduledAgentTaskView[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = await this.db.select({ task: scheduledAgentTasks, agentName: agents.name }).from(scheduledAgentTasks).innerJoin(agents, eq(scheduledAgentTasks.agentId, agents.id)).where(eq(scheduledAgentTasks.workspaceId, workspace.id)).orderBy(asc(scheduledAgentTasks.nextRunAt));
    return rows.map(({ task, agentName }) => toView(task, agentName));
  }

  async create(request: Request, workspaceSlug: string, input: CreateScheduledAgentTaskRequest): Promise<ScheduledAgentTaskView> {
    if (!input || typeof input.agentId !== 'string' || !input.agentId.trim() || typeof input.prompt !== 'string' || !input.prompt.trim() || !Number.isFinite(input.intervalSeconds) || input.intervalSeconds < 30) throw new BadRequestException('A custom Agent, prompt, and interval of at least 30 seconds are required.');
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [agent] = await this.db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.workspaceId, workspace.id))).limit(1);
    if (!agent || agent.kind !== 'custom') throw new NotFoundException('Custom Agent not found');
    if (!agent.providerId || !agent.model) throw new BadRequestException('The scheduled Agent must have a configured provider and model.');
    const now = new Date();
    const [task] = await this.db.insert(scheduledAgentTasks).values({ id: `sat_${randomUUID()}`, workspaceId: workspace.id, agentId: agent.id, label: input.label?.trim() || 'Scheduled task', prompt: input.prompt.trim(), intervalSeconds: Math.round(input.intervalSeconds), nextRunAt: new Date(now.getTime() + Math.round(input.intervalSeconds) * 1_000), createdAt: now, updatedAt: now }).returning();
    if (!task) throw new Error('Scheduled task could not be created.');
    return toView(task, agent.name);
  }

  async remove(request: Request, workspaceSlug: string, taskId: string): Promise<void> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const result = await this.db.delete(scheduledAgentTasks).where(and(eq(scheduledAgentTasks.id, taskId), eq(scheduledAgentTasks.workspaceId, workspace.id))).run();
    if (result.changes === 0) throw new NotFoundException('Scheduled task not found');
  }

  private async runDueTasks(): Promise<void> {
    const now = new Date();
    const due = await this.db.select().from(scheduledAgentTasks).where(and(lte(scheduledAgentTasks.nextRunAt, now), eq(scheduledAgentTasks.running, false))).limit(20);
    for (const task of due) {
      const claimed = await this.db.update(scheduledAgentTasks).set({ running: true, lastRunAt: now, updatedAt: now }).where(and(eq(scheduledAgentTasks.id, task.id), eq(scheduledAgentTasks.running, false))).run();
      if (claimed.changes === 0) continue;
      try {
        const executionId = await this.executions.createBackgroundExecution(task.workspaceId, task.agentId, task.prompt);
        await this.db.update(scheduledAgentTasks).set({ activeExecutionId: executionId, nextRunAt: new Date(now.getTime() + task.intervalSeconds * 1_000), updatedAt: new Date() }).where(eq(scheduledAgentTasks.id, task.id));
        void this.watchExecution(task.id, executionId, task.intervalSeconds);
      } catch {
        await this.db.update(scheduledAgentTasks).set({ running: false, lastStatus: 'failed', nextRunAt: new Date(now.getTime() + task.intervalSeconds * 1_000), unread: true, updatedAt: new Date() }).where(eq(scheduledAgentTasks.id, task.id));
      }
    }
  }

  private async watchExecution(taskId: string, executionId: string, intervalSeconds: number): Promise<void> {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const [execution] = await this.db.select({ status: agentExecutions.status }).from(agentExecutions).where(eq(agentExecutions.id, executionId)).limit(1);
      if (!execution) return;
      if (execution.status === 'running' || execution.status === 'waiting_for_input') continue;
      await this.db.update(scheduledAgentTasks).set({ running: false, activeExecutionId: null, lastStatus: execution.status, unread: true, nextRunAt: new Date(Date.now() + intervalSeconds * 1_000), updatedAt: new Date() }).where(eq(scheduledAgentTasks.id, taskId));
      return;
    }
  }
}

function toView(task: typeof scheduledAgentTasks.$inferSelect, agentName: string): ScheduledAgentTaskView {
  return { id: task.id, agentId: task.agentId, agentName, label: task.label, prompt: task.prompt, intervalSeconds: task.intervalSeconds, nextRunAt: task.nextRunAt.toISOString(), lastRunAt: task.lastRunAt?.toISOString() ?? null, lastStatus: task.lastStatus ?? null, unread: task.unread, running: task.running, createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString() };
}
