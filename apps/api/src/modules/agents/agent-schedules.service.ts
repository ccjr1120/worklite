import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, eq, lte } from 'drizzle-orm';
import type { Request } from 'express';
import { agentExecutions, scheduledAgentTasks, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { runtimeAdmissionClosed } from '../../infrastructure/runtime-upgrade-state';
import { AgentExecutionsService } from './agent-executions.service';

@Injectable()
export class AgentSchedulesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentSchedulesService.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly executions: AgentExecutionsService) {}
  onModuleInit(): void {
    if (process.env.WORKLITE_PREFLIGHT === '1') return;
    this.timer = setInterval(() => void this.tick(), 10_000); this.timer.unref();
    void this.tick();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
  async tick(): Promise<void> {
    if (this.ticking || runtimeAdmissionClosed()) return;
    this.ticking = true;
    try {
      const running = this.db.select().from(scheduledAgentTasks).where(eq(scheduledAgentTasks.running, true)).all();
      for (const task of running) {
        const execution = task.activeExecutionId ? this.db.select().from(agentExecutions).where(eq(agentExecutions.id, task.activeExecutionId)).get() : undefined;
        if (execution && ['running', 'waiting_for_input'].includes(execution.status)) continue;
        this.db.update(scheduledAgentTasks).set({ running: false, activeExecutionId: null, lastStatus: execution?.status ?? 'failed', nextRunAt: new Date(Date.now() + task.intervalSeconds * 1000), updatedAt: new Date() }).where(eq(scheduledAgentTasks.id, task.id)).run();
      }
      const due = this.db.select().from(scheduledAgentTasks).where(and(eq(scheduledAgentTasks.enabled, true), eq(scheduledAgentTasks.running, false), lte(scheduledAgentTasks.nextRunAt, new Date()))).all();
      for (const task of due) {
        if (runtimeAdmissionClosed()) break;
        const acquired = this.db.update(scheduledAgentTasks).set({ running: true, lastRunAt: new Date(), updatedAt: new Date() }).where(and(eq(scheduledAgentTasks.id, task.id), eq(scheduledAgentTasks.running, false))).run();
        if (!acquired.changes) continue;
        try {
          await this.executions.create({} as Request, 'personal', task.agentId, { message: task.prompt }, (tx, executionId) => {
            tx.update(scheduledAgentTasks).set({ activeExecutionId: executionId, lastStatus: 'running' }).where(eq(scheduledAgentTasks.id, task.id)).run();
          });
        } catch (error) {
          this.db.update(scheduledAgentTasks).set({ running: false, lastStatus: 'failed', nextRunAt: new Date(Date.now() + task.intervalSeconds * 1000), updatedAt: new Date() }).where(eq(scheduledAgentTasks.id, task.id)).run();
          this.logger.warn(`Scheduled Agent task ${task.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) { this.logger.warn(error instanceof Error ? error.message : 'Agent schedule check failed.'); }
    finally { this.ticking = false; }
  }
}
