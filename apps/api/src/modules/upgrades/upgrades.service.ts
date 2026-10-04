import { BadRequestException, Body, Controller, Get, Headers, Inject, Injectable, NotFoundException, OnModuleInit, Param, Post, UnauthorizedException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { agentExecutions, agentTeamRuns, chatSubmissions, commandExecutions, feishuChats, workflowRuns, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { upgradeStateDirectory } from '../../infrastructure/runtime-upgrade-state';
import { AgentTeamRuntimeService } from '../agent-teams/agent-team-runtime.service';
import { RunsService } from '../runs/runs.service';
import type { FeishuService } from '../plugins/feishu/feishu.service';
import type { FeishuRegistrationService } from '../plugins/feishu/feishu-registration.service';
import type { Request } from 'express';

type UpgradeJob = {
  id: string; releaseHash: string; releaseDirectory: string; summary: string; phase: string;
  workspaceId: string; submissionId: string; executionId: string; token: string;
  pausedTeams: string[]; pausedWorkflows: string[]; runnerPid?: number;
  confirmedAt?: string; confirmedBy?: string; error?: string; updatedAt: string;
  resumePending?: boolean;
};

@Injectable()
export class UpgradesService implements OnModuleInit {
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private resuming = false;
  private resumeWork?: Promise<{ resumed: boolean }>;
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly modules: ModuleRef) {}

  onModuleInit(): void {
    if (process.env.WORKLITE_PREFLIGHT === '1') return;
    const directory = upgradeStateDirectory();
    if (!directory) return;
    this.recoveryTimer = setInterval(() => {
      if (!existsSync(join(directory, 'active.json')) || this.resuming) return;
      const { jobId } = this.readFile<{ jobId: string }>(join(directory, 'active.json'));
      const job = this.load(jobId);
      if (job.resumePending && ['succeeded', 'rolled_back', 'failed'].includes(job.phase)) {
        this.resuming = true;
        void this.resume(jobId).catch(() => undefined).finally(() => { this.resuming = false; });
      } else if (job.confirmedAt && !['succeeded', 'rolled_back', 'failed'].includes(job.phase) && !alive(job.runnerPid)) this.launch(job);
    }, 5_000);
    this.recoveryTimer.unref();
  }
  onModuleDestroy(): void { if (this.recoveryTimer) clearInterval(this.recoveryTimer); }

  async propose(input: { summary: string; executionId: string; submissionId: string }) {
    const directory = this.directory();
    const runtime = this.readFile<{ projectRoot: string }>(join(directory, 'current.json'));
    const [execution] = await this.db.select().from(agentExecutions).where(and(eq(agentExecutions.id, input.executionId), eq(agentExecutions.agentId, 'agt_system_helper_chat'))).limit(1);
    if (!execution || !input.summary?.trim()) throw new BadRequestException('A Chat execution and upgrade summary are required.');
    const [chat] = await this.db.select({ id: feishuChats.id }).from(feishuChats).where(eq(feishuChats.executionId, execution.id)).limit(1);
    if (!chat) throw new BadRequestException('Upgrade requests need a Feishu conversation for release confirmation.');
    const [existing] = await this.db.select().from(chatSubmissions).where(eq(chatSubmissions.id, input.submissionId)).limit(1);
    if (existing?.reference?.kind === 'upgrade') return this.view(existing.reference.jobId);
    const id = `upgrade_${randomUUID()}`;
    const release = JSON.parse(execFileSync(process.execPath, [join(process.env.WORKLITE_RELEASE_ROOT!, 'scripts/upgrade-runner.mjs'), 'prepare', runtime.projectRoot, directory, id], { encoding: 'utf8' })) as { releaseHash: string; releaseDirectory: string };
    const job: UpgradeJob = { id, ...release, summary: input.summary.trim(), phase: 'awaiting_confirmation', workspaceId: execution.workspaceId, submissionId: input.submissionId, executionId: execution.id, token: randomBytes(32).toString('hex'), pausedTeams: [], pausedWorkflows: [], updatedAt: new Date().toISOString() };
    this.save(job);
    await this.db.insert(chatSubmissions).values({ id: input.submissionId, workspaceId: execution.workspaceId, chatId: chat.id, executionId: execution.id, message: job.summary, target: { kind: 'conversation' }, reference: { kind: 'upgrade', jobId: id } }).onConflictDoNothing();
    return this.view(id);
  }

  view(id: string) {
    const job = this.load(id);
    return { id: job.id, releaseHash: job.releaseHash, summary: job.summary, phase: job.phase, error: job.error ?? null, updatedAt: job.updatedAt };
  }

  confirm(id: string, hash: string, userId: string): void {
    const job = this.load(id);
    if (job.releaseHash !== hash || job.phase !== 'awaiting_confirmation') throw new BadRequestException('This upgrade confirmation is no longer current.');
    const directory = this.directory();
    if (existsSync(join(directory, 'active.json'))) {
      const { jobId } = this.readFile<{ jobId: string }>(join(directory, 'active.json'));
      const active = this.load(jobId);
      if (active.resumePending || !['succeeded', 'rolled_back', 'failed'].includes(active.phase)) throw new BadRequestException('Another upgrade is active.');
    }
    job.confirmedAt = new Date().toISOString(); job.confirmedBy = userId; job.phase = 'authorized';
    this.save(job);
    atomicWrite(join(directory, 'active.json'), { jobId: id });
    this.launch(job);
  }

  authorizeRunner(id: string, token: string | undefined): void {
    const job = this.load(id);
    if (!token || token !== job.token || !job.confirmedAt) throw new UnauthorizedException('A confirmed upgrade runner is required.');
  }

  async handoff(id: string) {
    const job = this.load(id);
    if (job.phase !== 'draining') throw new BadRequestException('Upgrade is not draining.');
    const [activeTurn] = await this.db.select({ id: agentExecutions.id }).from(agentExecutions).where(eq(agentExecutions.status, 'running')).limit(1);
    if (activeTurn) return { ready: false };
    const runtime = this.modules.get(AgentTeamRuntimeService, { strict: false });
    const runs = this.modules.get(RunsService, { strict: false });
    const teams = await this.db.select().from(agentTeamRuns).where(inArray(agentTeamRuns.status, ['queued', 'running', 'waiting_for_input']));
    const workflows = await this.db.select().from(workflowRuns).where(inArray(workflowRuns.status, ['queued', 'running', 'waiting_for_input']));
    // Record handoff ownership before requesting a pause, including across runner restart.
    job.pausedTeams = [...new Set([...job.pausedTeams, ...teams.map((run) => run.id)])];
    job.pausedWorkflows = [...new Set([...job.pausedWorkflows, ...workflows.map((run) => run.id)])];
    this.save(job);
    for (const run of teams) await runtime.pause(run.id);
    for (const run of workflows) await runs.pause({} as Request, 'personal', run.id);
    const [command] = await this.db.select({ id: commandExecutions.id }).from(commandExecutions).where(inArray(commandExecutions.status, ['queued', 'running', 'cancelling'])).limit(1);
    const registration = this.modules.get<FeishuRegistrationService>('FEISHU_REGISTRATION_RUNTIME', { strict: false });
    return { ready: !command && runtime.upgradeQuiescent() && runs.upgradeQuiescent() && registration.upgradeQuiescent() };
  }

  async resume(id: string) {
    if (this.resumeWork) return this.resumeWork;
    this.resumeWork = this.resumeHandoff(id);
    try { return await this.resumeWork; } finally { this.resumeWork = undefined; }
  }

  private async resumeHandoff(id: string) {
    const job = this.load(id);
    if (!['succeeded', 'rolled_back', 'failed'].includes(job.phase)) throw new BadRequestException('Upgrade has not settled.');
    const runtime = this.modules.get(AgentTeamRuntimeService, { strict: false });
    const runs = this.modules.get(RunsService, { strict: false });
    for (const runId of job.pausedTeams) {
      const [run] = await this.db.select({ status: agentTeamRuns.status }).from(agentTeamRuns).where(eq(agentTeamRuns.id, runId)).limit(1);
      if (run?.status === 'paused') await runtime.resume(runId);
    }
    for (const runId of job.pausedWorkflows) {
      const [run] = await this.db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
      if (run?.status === 'paused') await runs.resume({} as Request, 'personal', runId);
    }
    const feishu = this.modules.get<FeishuService>('FEISHU_UPGRADE_TRANSPORT', { strict: false });
    await feishu.connect();
    job.resumePending = false; this.save(job);
    return { resumed: true };
  }

  async freeze(id: string) {
    const job = this.load(id);
    if (job.phase !== 'draining') throw new BadRequestException('Upgrade is not draining.');
    const { ready } = await this.handoff(id);
    if (!ready) throw new BadRequestException('Work has not reached its handoff boundary.');
    const current = this.load(id); current.phase = 'frozen'; this.save(current);
    await this.modules.get<FeishuService>('FEISHU_UPGRADE_TRANSPORT', { strict: false }).freezeForUpgrade();
    return { frozen: true };
  }

  private launch(job: UpgradeJob) {
    const fd = openSync(join(this.directory(), 'upgrades', `${job.id}.log`), 'a', 0o600);
    const child = spawn(process.execPath, [join(process.env.WORKLITE_RELEASE_ROOT!, 'scripts/upgrade-runner.mjs'), 'run', this.directory(), job.id], { detached: true, stdio: ['ignore', fd, fd], env: process.env });
    closeSync(fd); child.unref();
    // Runner writes its own PID; never overwrite its phase from the API.
  }
  private directory() {
    const directory = upgradeStateDirectory();
    if (!directory || !process.env.WORKLITE_RELEASE_ROOT || !existsSync(join(directory, 'current.json'))) throw new BadRequestException('Initialize a managed WorkLite runtime before requesting conversational upgrades.');
    return directory;
  }
  private load(id: string): UpgradeJob {
    if (!/^upgrade_[a-f0-9-]+$/.test(id)) throw new NotFoundException('Upgrade not found.');
    const path = join(this.directory(), 'upgrades', `${id}.json`);
    if (!existsSync(path)) throw new NotFoundException('Upgrade not found.');
    return this.readFile<UpgradeJob>(path);
  }
  private save(job: UpgradeJob) { mkdirSync(join(this.directory(), 'upgrades'), { recursive: true }); atomicWrite(join(this.directory(), 'upgrades', `${job.id}.json`), { ...job, updatedAt: new Date().toISOString() }); }
  private readFile<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T; }
}

function alive(pid?: number) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function atomicWrite(path: string, value: unknown) { const temporary = `${path}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, path); }

@Controller('upgrades')
export class UpgradesController {
  constructor(private readonly upgrades: UpgradesService) {}
  @Get('runtime') runtime() { return { releaseHash: process.env.WORKLITE_RELEASE_HASH ?? null, wrapperPid: Number(process.env.WORKLITE_RUNTIME_PID ?? 0), preflight: process.env.WORKLITE_PREFLIGHT === '1' }; }
  @Post() propose(@Body() body: { summary: string; executionId: string; submissionId: string }) { return this.upgrades.propose(body); }
  @Get(':id') inspect(@Param('id') id: string) { return this.upgrades.view(id); }
  @Post(':id/handoff') handoff(@Param('id') id: string, @Headers('x-worklite-upgrade-token') token: string) { this.upgrades.authorizeRunner(id, token); return this.upgrades.handoff(id); }
  @Post(':id/resume') resume(@Param('id') id: string, @Headers('x-worklite-upgrade-token') token: string) { this.upgrades.authorizeRunner(id, token); return this.upgrades.resume(id); }
  @Post(':id/freeze') freeze(@Param('id') id: string, @Headers('x-worklite-upgrade-token') token: string) { this.upgrades.authorizeRunner(id, token); return this.upgrades.freeze(id); }
}
