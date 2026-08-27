import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Request } from 'express';
import type { AgentExecutionView, AgentToolCallView, ContinueAgentExecutionRequest, CreateAgentExecutionRequest, WorkliteNavigationTarget, WorkliteScriptResult } from '@worklite/contracts';
import { agentExecutions, agents, agentSkills, agentToolCalls, auditLogs, skillFiles, skills, type Database, type StoredAgentDisplayMessage, type StoredAgentModelMessage } from '@worklite/db';
import { createModelGateway, type GatewayAgentMessage, type GatewayToolResultOutput } from '@worklite/model-gateway';
import { DATABASE } from '../../infrastructure/database.module';
import { SkillScriptRunnerService } from '../skills/skill-script-runner.service';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { WorkspaceService } from '../teams/teams.service';

const MODEL_TIMEOUT_MS = 60_000;
const MAX_MESSAGE_LENGTH = 12_000;
const MAX_SESSION_MESSAGES = 50;
const SYSTEM_HELPER_CHAT_ID = 'agt_system_helper_chat';
const WORKLITE_PLATFORM_SKILL_ID = 'sk_worklite_platform';

const WORKLITE_NAVIGATION_ROUTES = {
  home: '/home', agents: '/agents', 'system-helper-chat': '/agents/agt_system_helper_chat', skills: '/skills', 'mcp-servers': '/mcp-servers', 'model-providers': '/model-providers', workflows: '/workflows', runs: '/runs', artifacts: '/artifacts', 'settings-appearance': '/settings/appearance', 'settings-usage': '/settings/usage', 'settings-audit-log': '/settings/audit-log',
} as const satisfies Record<WorkliteNavigationTarget, string>;

@Injectable()
export class AgentExecutionsService {
  private readonly activeModelRequests = new Map<string, AbortController>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly resources: WorkspaceResourcesService,
    private readonly skillScripts: SkillScriptRunnerService,
  ) {}

  async create(request: Request, workspaceSlug: string, agentId: string, input: CreateAgentExecutionRequest): Promise<AgentExecutionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.requireExecutableAgent(workspace.id, agentId);
    const content = normalizeUserMessage(input?.message);
    const id = `aex_${randomUUID()}`;
    const now = new Date().toISOString();
    const modelMessages: StoredAgentModelMessage[] = [{ role: 'user', content }];
    const displayMessages: StoredAgentDisplayMessage[] = [{ id: `msg_${randomUUID()}`, role: 'user', content, createdAt: now }];
    await this.db.insert(agentExecutions).values({ id, workspaceId: workspace.id, agentId, status: 'running', modelMessages, displayMessages });
    this.scheduleAdvance(request, workspaceSlug, id);
    return this.toView(await this.loadExecution(workspace.id, agentId, id));
  }

  async get(request: Request, workspaceSlug: string, agentId: string, executionId: string): Promise<AgentExecutionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
  }

  async continue(request: Request, workspaceSlug: string, agentId: string, executionId: string, input: ContinueAgentExecutionRequest): Promise<AgentExecutionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.requireExecutableAgent(workspace.id, agentId);
    const execution = await this.loadExecution(workspace.id, agentId, executionId);
    if (execution.status !== 'completed' && execution.status !== 'cancelled') throw new ConflictException('This Agent execution is not ready for another message.');
    if (execution.displayMessages.length >= MAX_SESSION_MESSAGES) throw new BadRequestException(`An Agent execution accepts at most ${MAX_SESSION_MESSAGES} messages.`);
    const content = normalizeUserMessage(input?.message);
    await this.db.update(agentExecutions).set({
      status: 'running',
      modelMessages: [...execution.modelMessages, { role: 'user', content }],
      displayMessages: [...execution.displayMessages, { id: `msg_${randomUUID()}`, role: 'user', content, createdAt: new Date().toISOString() }],
      error: null,
      updatedAt: new Date(),
    }).where(eq(agentExecutions.id, executionId));
    this.scheduleAdvance(request, workspaceSlug, executionId);
    return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
  }

  async cancel(request: Request, workspaceSlug: string, agentId: string, executionId: string): Promise<AgentExecutionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const execution = await this.loadExecution(workspace.id, agentId, executionId);
    if (execution.status !== 'running') return this.toView(execution);

    const calls = await this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.resultAppended, false)));
    const runningCalls = calls.filter((call) => call.status === 'running');
    const toolResults = runningCalls.map((call) => ({
      type: 'tool-result' as const,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: { type: 'error-text' as const, value: 'The Skill script was cancelled by the user.' },
    }));
    const modelMessages: StoredAgentModelMessage[] = toolResults.length > 0
      ? [...execution.modelMessages, { role: 'tool', content: toolResults }]
      : execution.modelMessages;
    const cancelledAt = new Date();
    let cancelled = false;

    this.db.transaction((transaction) => {
      const result = transaction.update(agentExecutions).set({ status: 'cancelled', modelMessages, error: null, updatedAt: cancelledAt }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running'))).run();
      if (result.changes === 0) return;
      cancelled = true;
      for (const call of runningCalls) {
        transaction.update(agentToolCalls).set({ status: 'cancelled', output: 'Skill execution cancelled.', resultAppended: true, finishedAt: cancelledAt }).where(and(eq(agentToolCalls.id, call.id), eq(agentToolCalls.status, 'running'))).run();
      }
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId: workspace.id, action: 'agent_execution.cancelled', resource: executionId, metadata: { agentId, commandExecutionIds: runningCalls.flatMap((call) => call.commandExecutionId ? [call.commandExecutionId] : []) } }).run();
    });

    if (cancelled) {
      this.activeModelRequests.get(executionId)?.abort();
      await Promise.all(runningCalls.flatMap((call) => call.commandExecutionId
        ? [this.skillScripts.cancel(call.commandExecutionId).catch(() => undefined)]
        : []));
    }
    return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
  }

  private scheduleAdvance(request: Request, workspaceSlug: string, executionId: string): void {
    void this.advance(request, workspaceSlug, executionId).catch(async () => {
      await this.db.update(agentExecutions).set({ status: 'failed', error: 'The Agent could not complete this turn.', updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running')));
    });
  }

  private async advance(request: Request, workspaceSlug: string, executionId: string): Promise<AgentExecutionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [execution] = await this.db.select().from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.workspaceId, workspace.id))).limit(1);
    if (!execution) throw new NotFoundException('Agent execution not found');
    if (execution.status !== 'running') return this.toView(execution);
    const { agent, assignedSkills } = await this.requireExecutableAgent(workspace.id, execution.agentId);
    const skillScripts = assignedSkills.flatMap((skill) => skill.files.filter((file) => file.path.startsWith('scripts/') && file.content.startsWith('#!')).map((file) => ({ skillId: skill.id, skillName: skill.name, path: file.path })));
    const skillInstructions = assignedSkills.map((skill) => `## ${skill.name}\n${skill.instructions.trim()}`).filter((value) => value.trim()).join('\n\n');
    const scriptList = skillScripts.map((script) => `- Skill ${script.skillName} (${script.skillId}): ${script.path}`).join('\n');
    const systemPrompt = [
      agent.systemPrompt.trim(),
      skillInstructions ? `Assigned Skill instructions:\n\n${skillInstructions}` : '',
      skillScripts.length > 0 ? 'Request at most one skill_script at a time. Every valid request executes immediately on the WorkLite host without user approval.' : '',
      scriptList ? `Assigned executable Skill scripts:\n${scriptList}\nUse skill_script only with an exact listed Skill id and script path.` : '',
    ].filter(Boolean).join('\n\n');
    const abortController = new AbortController();
    this.activeModelRequests.set(executionId, abortController);
    const timeout = setTimeout(() => abortController.abort(), MODEL_TIMEOUT_MS);

    try {
      const runtime = await this.resources.providerRuntime(request, workspaceSlug, agent.providerId!, agent.model);
      const result = await createModelGateway().generateAgentStep({ provider: runtime.provider, model: runtime.model, systemPrompt, messages: execution.modelMessages as GatewayAgentMessage[], skillScripts, maxOutputTokens: 2_048, abortSignal: abortController.signal });
      if (!result.text.trim() && result.toolCalls.length === 0) throw new Error('Empty Agent response');
      if (result.toolCalls.length > 1) throw new Error('Only one Skill script may be requested per Agent step.');
      const currentExecution = await this.loadExecution(workspace.id, execution.agentId, executionId);
      if (currentExecution.status !== 'running') return this.toView(currentExecution);
      const modelMessages = [...execution.modelMessages, ...result.responseMessages] as StoredAgentModelMessage[];
      const displayMessages = result.text.trim() ? [...execution.displayMessages, { id: `msg_${randomUUID()}`, role: 'assistant' as const, content: result.text, createdAt: new Date().toISOString() }] : execution.displayMessages;
      const status = result.toolCalls.length > 0 ? 'running' as const : 'completed' as const;
      let runningCallId: string | null = null;
      let turnUpdated = false;

      this.db.transaction((transaction) => {
        const updated = transaction.update(agentExecutions).set({ status, modelMessages, displayMessages, error: null, updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running'))).run();
        if (updated.changes === 0) return;
        turnUpdated = true;
        for (const requestedCall of result.toolCalls) {
          const callId = `acall_${randomUUID()}`;
          const skill = assignedSkills.find((item) => item.id === requestedCall.skillId);
          const script = skill?.files.find((file) => file.path === requestedCall.scriptPath && file.path.startsWith('scripts/') && file.content.startsWith('#!'));
          if (!skill || !script) throw new BadRequestException('The model requested a Skill script that is not assigned or executable.');
          const workingDirectory = process.cwd();
          runningCallId = callId;
          transaction.insert(agentToolCalls).values({ id: callId, executionId, workspaceId: workspace.id, agentId: execution.agentId, toolCallId: requestedCall.toolCallId, toolName: requestedCall.toolName, workingDirectory, skillId: skill.id, skillName: skill.name, scriptPath: script.path, arguments: requestedCall.arguments, packageFiles: skill.files, status: 'running' }).run();
          transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId: workspace.id, action: 'skill_script.requested', resource: callId, metadata: { agentId: execution.agentId, executionId, skillId: skill.id, skillName: skill.name, scriptPath: script.path, arguments: requestedCall.arguments, workingDirectory } }).run();
        }
      });
      if (turnUpdated && runningCallId) {
        void this.executeToolCall(request, workspaceSlug, workspace.id, execution.agentId, executionId, runningCallId).catch(async () => {
          await this.db.update(agentExecutions).set({ status: 'failed', error: 'The Agent Skill script could not be completed.', updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running')));
        });
      }
    } catch {
      await this.db.update(agentExecutions).set({ status: 'failed', error: 'The Agent could not complete this turn. Check its provider configuration and try again.', updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running')));
    } finally {
      clearTimeout(timeout);
      if (this.activeModelRequests.get(executionId) === abortController) this.activeModelRequests.delete(executionId);
    }
    return this.toView(await this.loadExecution(workspace.id, execution.agentId, executionId));
  }

  private async executeToolCall(request: Request, workspaceSlug: string, workspaceId: string, agentId: string, executionId: string, callId: string): Promise<void> {
    const [call] = await this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.id, callId), eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.agentId, agentId), eq(agentToolCalls.workspaceId, workspaceId))).limit(1);
    if (!call) throw new NotFoundException('Agent tool request not found');
    if (call.status !== 'running') return;

    let result: AgentScriptExecutionResult;
    let commandExecutionId: string | null = null;
    try {
      await this.requireSkillAssignment(workspaceId, agentId, call.skillId);
      const started = await this.skillScripts.start(call.packageFiles, call.scriptPath ?? '', call.arguments);
      commandExecutionId = started.id;
      const [linked] = await this.db.update(agentToolCalls).set({ commandExecutionId: started.id }).where(and(eq(agentToolCalls.id, callId), eq(agentToolCalls.status, 'running'))).returning({ id: agentToolCalls.id });
      const execution = await this.loadExecution(workspaceId, agentId, executionId);
      if (!linked || execution.status !== 'running') {
        await this.skillScripts.cancel(started.id).catch(() => undefined);
        return;
      }
      const completed = await this.skillScripts.wait(started.id);
      const parsedResult = completed.execution.status === 'succeeded' && call.skillId === WORKLITE_PLATFORM_SKILL_ID
        ? parseWorkliteScriptResult(completed.output)
        : null;
      const succeeded = completed.execution.status === 'succeeded' && (call.skillId !== WORKLITE_PLATFORM_SKILL_ID || parsedResult !== null);
      result = {
        status: completed.execution.status === 'cancelled' ? 'cancelled' : succeeded ? 'completed' : 'failed',
        output: completed.output,
        result: parsedResult,
        exitCode: completed.execution.exitCode,
        commandExecutionId: completed.execution.id,
      };
    } catch {
      result = { status: 'failed', output: 'Host execution could not be started.', result: null, exitCode: null, commandExecutionId };
    }
    const finishedAt = new Date();
    let finalized = false;
    this.db.transaction((transaction) => {
      const updated = transaction.update(agentToolCalls).set({ ...result, finishedAt }).where(and(eq(agentToolCalls.id, callId), eq(agentToolCalls.status, 'running'))).run();
      if (updated.changes === 0) return;
      finalized = true;
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId, action: `${call.toolName}.${result.status}`, resource: callId, metadata: { ...toolAuditMetadata(call), commandExecutionId: result.commandExecutionId, exitCode: result.exitCode } }).run();
    });
    if (finalized && result.status !== 'cancelled') await this.resumeAfterToolCalls(request, workspaceSlug, workspaceId, agentId, executionId);
  }

  private async resumeAfterToolCalls(request: Request, workspaceSlug: string, workspaceId: string, agentId: string, executionId: string): Promise<AgentExecutionView> {
    const activeExecution = await this.loadExecution(workspaceId, agentId, executionId);
    if (activeExecution.status !== 'running') return this.toView(activeExecution);
    const calls = await this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.resultAppended, false)));
    if (calls.some((call) => call.status === 'running')) {
      await this.db.update(agentExecutions).set({ status: 'running', updatedAt: new Date() }).where(eq(agentExecutions.id, executionId));
      return this.toView(await this.loadExecution(workspaceId, agentId, executionId));
    }
    const execution = await this.loadExecution(workspaceId, agentId, executionId);
    const toolResults = calls.map((call) => ({ type: 'tool-result' as const, toolCallId: call.toolCallId, toolName: call.toolName, output: toolCallOutput(call) }));
    const modelMessages: StoredAgentModelMessage[] = [...execution.modelMessages, { role: 'tool', content: toolResults }];
    let shouldAdvance = false;
    this.db.transaction((transaction) => {
      const updated = transaction.update(agentExecutions).set({ status: 'running', modelMessages, updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running'))).run();
      if (updated.changes === 0) return;
      shouldAdvance = true;
      for (const call of calls) transaction.update(agentToolCalls).set({ resultAppended: true }).where(eq(agentToolCalls.id, call.id)).run();
    });
    return shouldAdvance ? this.advance(request, workspaceSlug, executionId) : this.toView(await this.loadExecution(workspaceId, agentId, executionId));
  }

  private async requireExecutableAgent(workspaceId: string, agentId: string) {
    const [agent] = await this.db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId))).limit(1);
    if (!agent) throw new NotFoundException('Agent not found');
    if (agent.kind !== 'custom' && agent.id !== SYSTEM_HELPER_CHAT_ID) throw new BadRequestException('This built-in Agent cannot be executed.');
    if (!agent.providerId || !agent.model) throw new ConflictException('Configure a model provider and model before running this Agent.');
    const rows = await this.db.select({ id: skills.id, name: skills.name, instructions: skills.instructions }).from(agentSkills).innerJoin(skills, eq(agentSkills.skillId, skills.id)).where(and(eq(agentSkills.agentId, agentId), eq(skills.workspaceId, workspaceId)));
    const files = rows.length === 0 ? [] : await this.db.select().from(skillFiles).where(inArray(skillFiles.skillId, rows.map((skill) => skill.id)));
    return { agent, assignedSkills: rows.map((skill) => ({ ...skill, files: files.filter((file) => file.skillId === skill.id).map(({ path, content }) => ({ path, content })) })) };
  }

  private async requireSkillAssignment(workspaceId: string, agentId: string, skillId: string | null): Promise<void> {
    if (!skillId) throw new ConflictException('The Skill script request has no Skill assignment.');
    const [assignment] = await this.db.select({ id: skills.id }).from(agentSkills).innerJoin(skills, eq(agentSkills.skillId, skills.id)).where(and(eq(agentSkills.agentId, agentId), eq(skills.workspaceId, workspaceId), eq(skills.id, skillId))).limit(1);
    if (!assignment) throw new ConflictException('This Agent no longer has the requested Skill.');
  }

  private async loadExecution(workspaceId: string, agentId: string, executionId: string) {
    const [execution] = await this.db.select().from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.agentId, agentId), eq(agentExecutions.workspaceId, workspaceId))).limit(1);
    if (!execution) throw new NotFoundException('Agent execution not found');
    return execution;
  }

  private async toView(execution: typeof agentExecutions.$inferSelect): Promise<AgentExecutionView> {
    const calls = await this.db.select().from(agentToolCalls).where(eq(agentToolCalls.executionId, execution.id)).orderBy(agentToolCalls.createdAt);
    return { id: execution.id, agentId: execution.agentId, status: execution.status, messages: execution.displayMessages, toolCalls: calls.map(toToolCallView), error: execution.error, createdAt: execution.createdAt.toISOString(), updatedAt: execution.updatedAt.toISOString() };
  }
}

function normalizeUserMessage(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw new BadRequestException('An Agent message is required.');
  const content = input.trim();
  if (content.length > MAX_MESSAGE_LENGTH) throw new BadRequestException(`An Agent message cannot exceed ${MAX_MESSAGE_LENGTH} characters.`);
  return content;
}

function toolCallOutput(call: typeof agentToolCalls.$inferSelect): GatewayToolResultOutput {
  const details = [`status=${call.status}`, `exitCode=${call.exitCode ?? 'none'}`, '', call.output || '(no output)'].join('\n');
  return call.status === 'completed' ? { type: 'text', value: details } : { type: 'error-text', value: details };
}

function toToolCallView(call: typeof agentToolCalls.$inferSelect): AgentToolCallView {
  return { id: call.id, workingDirectory: call.workingDirectory, skillId: call.skillId, skillName: call.skillName, scriptPath: call.scriptPath, arguments: call.arguments, status: call.status, output: call.output, exitCode: call.exitCode, commandExecutionId: call.commandExecutionId, result: call.result, createdAt: call.createdAt.toISOString(), finishedAt: call.finishedAt?.toISOString() ?? null };
}

function toolAuditMetadata(call: typeof agentToolCalls.$inferSelect): Record<string, unknown> {
  return { agentId: call.agentId, executionId: call.executionId, toolName: call.toolName, workingDirectory: call.workingDirectory, skillId: call.skillId, skillName: call.skillName, scriptPath: call.scriptPath, arguments: call.arguments };
}

type AgentScriptExecutionResult = {
  status: 'completed' | 'failed' | 'cancelled';
  output: string;
  result: WorkliteScriptResult | null;
  exitCode: number | null;
  commandExecutionId: string | null;
};

function parseWorkliteScriptResult(output: string): WorkliteScriptResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return null;
  }
  const wrapper = asRecord(parsed);
  const result = asRecord(wrapper?.worklite);
  if (!result || typeof result.type !== 'string') return null;
  if (result.type === 'snapshot') return Object.keys(result).length === 1 ? { type: 'snapshot' } : null;
  if (result.type === 'settings') {
    const appearance = result.appearance;
    const locale = result.locale;
    return (appearance === 'system' || appearance === 'light' || appearance === 'dark') && (locale === 'en' || locale === 'zh-CN')
      ? { type: 'settings', appearance, locale }
      : null;
  }
  if (result.type === 'navigation') {
    const target = result.target as WorkliteNavigationTarget;
    const route = typeof result.route === 'string' ? result.route : '';
    return WORKLITE_NAVIGATION_ROUTES[target] === route ? { type: 'navigation', target, route } : null;
  }
  if (result.type === 'resource') {
    const resourceType = result.resourceType;
    const id = typeof result.id === 'string' && result.id.length > 0 && result.id.length <= 240 ? result.id : null;
    const route = typeof result.route === 'string' ? result.route : '';
    if (!id || (resourceType !== 'provider' && resourceType !== 'agent' && resourceType !== 'skill' && resourceType !== 'mcp-server' && resourceType !== 'workflow')) return null;
    const expectedRoute = resourceType === 'provider' ? '/model-providers' : `/${resourceType === 'mcp-server' ? 'mcp-servers' : `${resourceType}s`}/${encodeURIComponent(id)}`;
    return route === expectedRoute ? { type: 'resource', resourceType, id, route } : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
