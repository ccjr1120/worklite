import { BadRequestException, Body, Controller, Get, Headers, Inject, Injectable, Logger, NotFoundException, OnModuleInit, Param, Post, UnauthorizedException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { agentExecutions, agentTeamRuns, agentToolCalls, chatProjectTasks, chatSubmissions, commandExecutions, externalChats, workflowRuns, type Database } from '@worklite/db';
import type { WorkliteUpgradeView } from '@worklite/contracts';
import { DATABASE } from '../../infrastructure/database.module';
import { upgradeStateDirectory } from '../../infrastructure/runtime-upgrade-state';
import { AgentTeamRuntimeService } from '../agent-teams/agent-team-runtime.service';
import { AgentExecutionsService } from '../agents/agent-executions.service';
import { CommandsService } from '../commands/commands.service';
import { RunsService } from '../runs/runs.service';
import type { FeishuService } from '../plugins/feishu/feishu.service';
import type { FeishuRegistrationService } from '../plugins/feishu/feishu-registration.service';
import type { WechatService } from '../plugins/wechat/wechat.service';
import type { Request } from 'express';

type UpgradeJob = {
  id: string; releaseHash: string; gatewayHash?: string; releaseDirectory: string; summary: string; phase: string;
  workspaceId: string; submissionId: string; executionId: string; token: string;
  pausedTeams: string[]; pausedWorkflows: string[]; runnerPid?: number;
  confirmedAt?: string; confirmedBy?: string; error?: string; updatedAt: string;
  interruptionPolicy?: 'cancel_active_work_without_resume';
  interruptedWork?: { agentExecutions: string[]; teamRuns: string[]; workflowRuns: string[]; commands: string[]; feishuRegistration: boolean };
  interruptionFailures?: string[];
  authorization?: { userMessageId: string; userRequest: string; toolCallId: string };
};

@Injectable()
export class UpgradesService implements OnModuleInit {
  private readonly logger = new Logger(UpgradesService.name);
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private readonly projectTaskRedeploys = new Map<string, Promise<WorkliteUpgradeView>>();
  private projectTaskRedeployQueue: Promise<void> = Promise.resolve();
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly modules: ModuleRef) {}

  async onModuleInit(): Promise<void> {
    if (process.env.WORKLITE_PREFLIGHT === '1') return;
    const directory = upgradeStateDirectory();
    if (!directory) return;
    if (existsSync(join(directory, 'active.json'))) {
      const { jobId } = this.readFile<{ jobId: string }>(join(directory, 'active.json'));
      const job = this.load(jobId);
      if (job.interruptionPolicy === 'cancel_active_work_without_resume' && ['switching', 'recovering'].includes(job.phase)) {
        await this.interruptActiveWork(jobId);
      }
    }
    this.recoveryTimer = setInterval(() => {
      if (!existsSync(join(directory, 'active.json'))) return;
      const { jobId } = this.readFile<{ jobId: string }>(join(directory, 'active.json'));
      const job = this.load(jobId);
      if (job.confirmedAt && !['succeeded', 'rolled_back', 'failed'].includes(job.phase) && !alive(job.runnerPid)) this.launch(job);
    }, 5_000);
    this.recoveryTimer.unref();
  }
  onModuleDestroy(): void { if (this.recoveryTimer) clearInterval(this.recoveryTimer); }

  async propose(input: { summary: string; executionId: string; submissionId: string }) {
    const directory = this.directory();
    const runtime = this.readFile<{ projectRoot: string }>(join(directory, 'current.json'));
    const [execution] = await this.db.select().from(agentExecutions).where(and(eq(agentExecutions.id, input.executionId), eq(agentExecutions.agentId, 'agt_system_helper_chat'))).limit(1);
    if (!execution || !input.summary?.trim()) throw new BadRequestException('A Chat execution and upgrade summary are required.');
    const [chat] = await this.db.select({ id: externalChats.id }).from(externalChats).where(eq(externalChats.executionId, execution.id)).limit(1);
    const [existing] = await this.db.select().from(chatSubmissions).where(eq(chatSubmissions.id, input.submissionId)).limit(1);
    if (existing?.reference?.kind === 'upgrade') return this.view(existing.reference.jobId);
    const id = `upgrade_${randomUUID()}`;
    const release = JSON.parse(execFileSync(process.execPath, [join(runtime.projectRoot, 'scripts/upgrade-runner.mjs'), 'prepare', runtime.projectRoot, directory, id], { encoding: 'utf8' })) as { releaseHash: string; gatewayHash: string; releaseDirectory: string };
    const job: UpgradeJob = { id, ...release, summary: input.summary.trim(), phase: 'proposed', workspaceId: execution.workspaceId, submissionId: input.submissionId, executionId: execution.id, token: randomBytes(32).toString('hex'), pausedTeams: [], pausedWorkflows: [], updatedAt: new Date().toISOString() };
    this.save(job);
    await this.db.insert(chatSubmissions).values({ id: input.submissionId, workspaceId: execution.workspaceId, chatId: chat?.id, executionId: execution.id, message: job.summary, target: { kind: 'conversation' }, reference: { kind: 'upgrade', jobId: id } }).onConflictDoNothing();
    return this.view(id);
  }

  async redeploy(input: { summary: string; executionId: string; submissionId: string; userMessageId: string }) {
    const directory = this.directory();
    const [execution] = await this.db.select().from(agentExecutions).where(and(eq(agentExecutions.id, input.executionId), eq(agentExecutions.agentId, 'agt_system_helper_chat'))).limit(1);
    const userMessage = execution?.displayMessages.filter((message) => message.role === 'user').at(-1);
    const [call] = await this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.id, input.submissionId), eq(agentToolCalls.executionId, input.executionId))).limit(1);
    const currentTurn = execution ? execution.modelMessages.slice(execution.modelMessages.map((message) => message.role).lastIndexOf('user')) : [];
    const currentCall = currentTurn.some((message) => message.role === 'assistant' && message.content.some((part) => part.type === 'tool-call' && part.toolCallId === call?.toolCallId));
    if (!execution || execution.status !== 'running' || !userMessage || userMessage.id !== input.userMessageId || !input.summary?.trim()
      || call?.status !== 'running' || call.skillId !== 'sk_worklite_platform' || call.scriptPath !== 'scripts/redeploy.mjs' || !currentCall) {
      throw new BadRequestException('Redeployment requires the current server-bound Chat user request.');
    }
    const [chat] = await this.db.select({ id: externalChats.id }).from(externalChats).where(eq(externalChats.executionId, execution.id)).limit(1);
    const id = `upgrade_${createHash('sha256').update(`${execution.id}:${userMessage.id}`).digest('hex').slice(0, 32)}`;
    if (existsSync(join(directory, 'upgrades', `${id}.json`))) return this.view(id);
    this.requireIdle();
    const runtime = this.readFile<{ projectRoot: string }>(join(directory, 'current.json'));
    const release = JSON.parse(execFileSync(process.execPath, [join(runtime.projectRoot, 'scripts/upgrade-runner.mjs'), 'prepare', runtime.projectRoot, directory, id], { encoding: 'utf8' })) as { releaseHash: string; gatewayHash: string; releaseDirectory: string };
    const job: UpgradeJob = {
      id, ...release, summary: input.summary.trim(), phase: 'authorized', workspaceId: execution.workspaceId,
      submissionId: id, executionId: execution.id, token: randomBytes(32).toString('hex'), pausedTeams: [], pausedWorkflows: [],
      confirmedAt: new Date().toISOString(), confirmedBy: userMessage.id,
      interruptionPolicy: 'cancel_active_work_without_resume',
      authorization: { userMessageId: userMessage.id, userRequest: userMessage.content, toolCallId: call.id },
      updatedAt: new Date().toISOString(),
    };
    this.save(job);
    this.db.insert(chatSubmissions).values({ id, workspaceId: execution.workspaceId, chatId: chat?.id, executionId: execution.id, message: job.summary, target: { kind: 'conversation' }, reference: { kind: 'upgrade', jobId: id } }).onConflictDoNothing().run();
    atomicWrite(join(directory, 'active.json'), { jobId: id });
    this.launch(job);
    return this.view(id);
  }

  redeployAfterProjectTask(taskId: string): Promise<WorkliteUpgradeView> {
    const existing = this.projectTaskRedeploys.get(taskId);
    if (existing) return existing;

    const pending = this.projectTaskRedeployQueue.then(() => this.startProjectTaskRedeploy(taskId));
    this.projectTaskRedeploys.set(taskId, pending);
    this.projectTaskRedeployQueue = pending.then(() => undefined, () => undefined);
    const cleanup = () => {
      if (this.projectTaskRedeploys.get(taskId) === pending) this.projectTaskRedeploys.delete(taskId);
    };
    void pending.then(cleanup, cleanup);
    return pending;
  }

  private async startProjectTaskRedeploy(taskId: string): Promise<WorkliteUpgradeView> {
    const directory = this.directory();
    const [task] = await this.db.select().from(chatProjectTasks).where(eq(chatProjectTasks.id, taskId)).limit(1);
    const authorization = task?.snapshot.redeployAuthorization;
    if (!task || task.status !== 'succeeded' || task.snapshot.redeployAfterSuccess !== true || !authorization?.userMessageId) {
      throw new BadRequestException('Automatic redeployment requires a successfully completed project task with a captured user request.');
    }
    if (task.worktreePath || task.snapshot.readOnly === true) {
      throw new BadRequestException('Automatic redeployment requires task changes in the managed project root checkout.');
    }
    const [execution] = await this.db.select().from(agentExecutions)
      .where(and(eq(agentExecutions.id, task.executionId), eq(agentExecutions.workspaceId, task.workspaceId), eq(agentExecutions.agentId, 'agt_system_helper_chat'))).limit(1);
    const userMessage = execution?.displayMessages.find((message) => message.role === 'user' && message.id === authorization.userMessageId);
    const [call] = await this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.id, task.id), eq(agentToolCalls.executionId, task.executionId))).limit(1);
    const callInput = call?.input as { redeployAfterSuccess?: unknown } | undefined;
    if (!execution || !userMessage || call?.status !== 'completed' || call.mcpToolName !== 'project_task' || callInput?.redeployAfterSuccess !== true) {
      throw new BadRequestException('Automatic redeployment no longer matches its captured Chat request.');
    }

    const runtime = this.readFile<{ projectRoot: string }>(join(directory, 'current.json'));
    if (resolve(task.projectDirectory) !== resolve(runtime.projectRoot)) {
      throw new BadRequestException('Automatic redeployment requires the task to target the managed WorkLite project root.');
    }
    const id = `upgrade_${createHash('sha256').update(`${execution.id}:${userMessage.id}`).digest('hex').slice(0, 32)}`;
    const existingPath = join(directory, 'upgrades', `${id}.json`);
    if (existsSync(existingPath)) {
      const existing = this.load(id);
      if (!['succeeded', 'rolled_back', 'failed'].includes(existing.phase) && existing.confirmedAt) {
        const activePath = join(directory, 'active.json');
        const activeJobId = existsSync(activePath) ? this.readFile<{ jobId: string }>(activePath).jobId : undefined;
        if (activeJobId !== id) {
          this.requireIdle();
          atomicWrite(activePath, { jobId: id });
          this.launch(existing);
        }
      }
      return this.view(id);
    }
    this.requireIdle();

    const [chat] = await this.db.select({ id: externalChats.id }).from(externalChats).where(eq(externalChats.executionId, execution.id)).limit(1);
    const summary = [`项目任务已完成：${task.goal}`, task.result].filter(Boolean).join('\n\n').slice(0, 100_000);
    const release = JSON.parse(execFileSync(process.execPath, [join(runtime.projectRoot, 'scripts/upgrade-runner.mjs'), 'prepare', runtime.projectRoot, directory, id], { encoding: 'utf8' })) as { releaseHash: string; gatewayHash: string; releaseDirectory: string };
    const job: UpgradeJob = {
      id, ...release, summary, phase: 'authorized', workspaceId: execution.workspaceId,
      submissionId: id, executionId: execution.id, token: randomBytes(32).toString('hex'), pausedTeams: [], pausedWorkflows: [],
      confirmedAt: new Date().toISOString(), confirmedBy: userMessage.id,
      interruptionPolicy: 'cancel_active_work_without_resume',
      authorization: { userMessageId: userMessage.id, userRequest: userMessage.content, toolCallId: task.id },
      updatedAt: new Date().toISOString(),
    };
    this.save(job);
    this.db.insert(chatSubmissions).values({ id, workspaceId: execution.workspaceId, chatId: chat?.id, executionId: execution.id, message: summary, target: { kind: 'conversation' }, reference: { kind: 'upgrade', jobId: id } }).onConflictDoNothing().run();
    atomicWrite(join(directory, 'active.json'), { jobId: id });
    this.launch(job);
    return this.view(id);
  }

  async hasActiveProjectTasksForRoot(taskId: string): Promise<boolean> {
    const [task] = await this.db.select().from(chatProjectTasks).where(eq(chatProjectTasks.id, taskId)).limit(1);
    if (!task) throw new NotFoundException('Chat project task not found.');
    const active = await this.db.select({ id: chatProjectTasks.id, projectDirectory: chatProjectTasks.projectDirectory }).from(chatProjectTasks)
      .where(and(eq(chatProjectTasks.workspaceId, task.workspaceId), inArray(chatProjectTasks.status, ['running', 'waiting_for_input', 'waiting_for_recovery'])));
    return active.some((other) => other.id !== taskId && pathsOverlap(other.projectDirectory, task.projectDirectory));
  }

  view(id: string): WorkliteUpgradeView {
    const job = this.load(id);
    return { id: job.id, releaseHash: job.releaseHash, summary: job.summary, phase: job.phase, error: job.error ?? null, updatedAt: job.updatedAt, interruptionPolicy: 'cancel_active_work_without_resume' };
  }

  private requireIdle(): void {
    const directory = this.directory();
    if (existsSync(join(directory, 'active.json'))) {
      const { jobId } = this.readFile<{ jobId: string }>(join(directory, 'active.json'));
      const active = this.load(jobId);
      if (!['succeeded', 'rolled_back', 'failed'].includes(active.phase)) throw new BadRequestException('Another upgrade is active.');
    }
  }

  authorizeRunner(id: string, token: string | undefined): void {
    const job = this.load(id);
    if (!token || token !== job.token || !job.confirmedAt) throw new UnauthorizedException('A confirmed upgrade runner is required.');
  }

  async handoff(id: string) {
    const job = this.load(id);
    if (job.phase !== 'draining') throw new BadRequestException('Upgrade is not draining.');
    const interruptions = await this.interruptActiveWork(id);
    return { ready: true, interrupted: interruptions };
  }

  async complete(id: string) {
    const job = this.load(id);
    if (job.phase !== 'succeeded') throw new BadRequestException('Upgrade has not succeeded.');
    await this.modules.get<FeishuService>('FEISHU_UPGRADE_TRANSPORT', { strict: false }).connect();
    // A WeChat reconnect failure must not fail the upgrade completion itself; the monitor
    // also self-heals after a freeze, so this is a best-effort immediate reconnect.
    const wechat = this.modules.get<WechatService | undefined>('WECHAT_UPGRADE_TRANSPORT', { strict: false });
    if (wechat) {
      try {
        await wechat.connect();
      } catch (error) {
        const summary = error instanceof Error ? error.message : typeof error;
        this.logger.warn(`WeChat reconnect after upgrade ${id} failed: ${summary}`);
      }
    }
    return { connected: true };
  }

  private async interruptActiveWork(id: string) {
    const job = this.load(id);
    const activeAgents = await this.db.select({ id: agentExecutions.id, agentId: agentExecutions.agentId }).from(agentExecutions).where(inArray(agentExecutions.status, ['running', 'waiting_for_input']));
    const activeTeams = await this.db.select({ id: agentTeamRuns.id }).from(agentTeamRuns).where(inArray(agentTeamRuns.status, ['queued', 'running', 'waiting_for_input', 'paused']));
    const activeWorkflows = await this.db.select({ id: workflowRuns.id }).from(workflowRuns).where(inArray(workflowRuns.status, ['queued', 'running', 'waiting_for_input', 'paused']));
    const activeCommands = await this.db.select({ id: commandExecutions.id }).from(commandExecutions).where(inArray(commandExecutions.status, ['queued', 'running', 'cancelling']));
    const interruptedWork = {
      agentExecutions: [...new Set([...(job.interruptedWork?.agentExecutions ?? []), ...activeAgents.map(({ id: executionId }) => executionId)])],
      teamRuns: [...new Set([...(job.interruptedWork?.teamRuns ?? []), ...activeTeams.map(({ id: runId }) => runId)])],
      workflowRuns: [...new Set([...(job.interruptedWork?.workflowRuns ?? []), ...activeWorkflows.map(({ id: runId }) => runId)])],
      commands: [...new Set([...(job.interruptedWork?.commands ?? []), ...activeCommands.map(({ id: commandId }) => commandId)])],
      feishuRegistration: true,
    };
    job.interruptionPolicy = 'cancel_active_work_without_resume';
    job.interruptedWork = interruptedWork;
    this.save(job);

    const executions = this.modules.get(AgentExecutionsService, { strict: false });
    const teamRuntime = this.modules.get(AgentTeamRuntimeService, { strict: false });
    const runs = this.modules.get(RunsService, { strict: false });
    const commands = this.modules.get(CommandsService, { strict: false });
    const registration = this.modules.get<FeishuRegistrationService>('FEISHU_REGISTRATION_RUNTIME', { strict: false });
    const cancellationLabels = [
      ...activeAgents.map(({ id: executionId }) => `agent:${executionId}`),
      ...activeTeams.map(({ id: runId }) => `team:${runId}`),
      ...activeWorkflows.map(({ id: runId }) => `workflow:${runId}`),
      ...activeCommands.map(({ id: commandId }) => `command:${commandId}`),
      'feishu-registration',
    ];
    const cancellations = [
      ...activeAgents.map(({ id: executionId, agentId }) => executions.cancel({} as Request, 'personal', agentId, executionId)),
      ...activeTeams.map(({ id: runId }) => teamRuntime.cancel(runId)),
      ...activeWorkflows.map(({ id: runId }) => runs.cancel({} as Request, 'personal', runId, true)),
      ...activeCommands.map(async ({ id: commandId }) => {
        await commands.cancel(commandId);
        await commands.waitForCompletion(commandId);
      }),
      registration.cancelForUpgrade(),
    ];
    const settled = await Promise.allSettled(cancellations);
    const interruptionFailures = settled.flatMap((result, index) => result.status === 'rejected' ? [cancellationLabels[index]] : []);
    const latest = this.load(id);
    latest.interruptionFailures = interruptionFailures;
    this.save(latest);
    return {
      agentExecutions: activeAgents.length,
      teamRuns: activeTeams.length,
      workflowRuns: activeWorkflows.length,
      commands: activeCommands.length,
      failures: interruptionFailures.length,
    };
  }

  async freeze(id: string) {
    const job = this.load(id);
    if (job.phase !== 'draining') throw new BadRequestException('Upgrade is not draining.');
    await this.handoff(id);
    const current = this.load(id); current.phase = 'frozen'; this.save(current);
    await this.modules.get<FeishuService>('FEISHU_UPGRADE_TRANSPORT', { strict: false }).freezeForUpgrade();
    await this.modules.get<WechatService>('WECHAT_UPGRADE_TRANSPORT', { strict: false })?.freezeForUpgrade();
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
function pathsOverlap(left: string, right: string): boolean {
  const contains = (parent: string, child: string) => {
    const path = relative(resolve(parent), resolve(child));
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
  };
  return contains(left, right) || contains(right, left);
}
function atomicWrite(path: string, value: unknown) { const temporary = `${path}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, path); }

@Controller('upgrades')
export class UpgradesController {
  constructor(private readonly upgrades: UpgradesService) {}
  @Get('runtime') runtime() { return { releaseHash: process.env.WORKLITE_RELEASE_HASH ?? null, wrapperPid: Number(process.env.WORKLITE_RUNTIME_PID ?? 0), preflight: process.env.WORKLITE_PREFLIGHT === '1' }; }
  @Post() propose(@Body() body: { summary: string; executionId: string; submissionId: string }) { return this.upgrades.propose(body); }
  @Post('redeploy') redeploy(@Body() body: { summary: string; executionId: string; submissionId: string; userMessageId: string }) { return this.upgrades.redeploy(body); }
  @Get(':id') inspect(@Param('id') id: string) { return this.upgrades.view(id); }
  @Post(':id/handoff') handoff(@Param('id') id: string, @Headers('x-worklite-upgrade-token') token: string) { this.upgrades.authorizeRunner(id, token); return this.upgrades.handoff(id); }
  @Post(':id/complete') complete(@Param('id') id: string, @Headers('x-worklite-upgrade-token') token: string) { this.upgrades.authorizeRunner(id, token); return this.upgrades.complete(id); }
  @Post(':id/freeze') freeze(@Param('id') id: string, @Headers('x-worklite-upgrade-token') token: string) { this.upgrades.authorizeRunner(id, token); return this.upgrades.freeze(id); }
}
