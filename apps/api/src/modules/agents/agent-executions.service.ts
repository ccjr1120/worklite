import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { Request } from 'express';
import type { AgentExecutionErrorCode, AgentExecutionEvent, AgentExecutionEventData, AgentExecutionPhase, AgentExecutionView, AgentPendingQuestion, AgentPlanStep, AgentToolCallView, AnswerAgentQuestionRequest, ContinueAgentExecutionRequest, CreateAgentExecutionRequest, WorkliteNavigationTarget, WorkliteScriptResult } from '@worklite/contracts';
import { agentExecutionEvents, agentExecutions, agentVersions, agents, agentSkills, agentSubSessions, agentToolCalls, auditLogs, skillFiles, skills, type Database, type StoredAgentDisplayMessage, type StoredAgentModelMessage } from '@worklite/db';
import { createModelGateway, ModelGatewayError, type GatewayAgentMessage, type GatewayToolResultOutput } from '@worklite/model-gateway';
import { DATABASE } from '../../infrastructure/database.module';
import { SkillScriptRunnerService } from '../skills/skill-script-runner.service';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { WorkspaceService } from '../teams/teams.service';
import type { AgentMcpRuntime } from '../teams/team-resources.service';
import { McpRuntimeService } from './mcp-runtime.service';
import { BuiltinAgentToolsService } from './builtin-agent-tools.service';

const SYSTEM_HELPER_CHAT_ID = 'agt_system_helper_chat';
const WORKLITE_PLATFORM_SKILL_ID = 'sk_worklite_platform';
const MAX_HELPER_TOOL_ROUNDS = 24;

const HELPER_BUILTIN_TOOLS = [
  {
    name: 'update_plan',
    description: 'Create or update the complete execution plan for a multi-step task.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['steps'], properties: { explanation: { type: 'string' }, steps: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['step', 'status'], properties: { step: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } } } } } },
  },
  {
    name: 'ask_user',
    description: 'Ask one blocking clarification question during the dedicated planning clarification pass.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['question'], properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } } },
  },
] as const;

const WORKLITE_NAVIGATION_ROUTES = {
  home: '/home', agents: '/agents', 'system-helper-chat': '/agents/agt_system_helper_chat', skills: '/skills', 'mcp-servers': '/mcp-servers', 'model-providers': '/model-providers', workflows: '/workflows', runs: '/runs', artifacts: '/artifacts', 'settings-appearance': '/settings/appearance', 'settings-usage': '/settings/usage', 'settings-audit-log': '/settings/audit-log',
} as const satisfies Record<WorkliteNavigationTarget, string>;

@Injectable()
export class AgentExecutionsService {
  private readonly activeModelRequests = new Map<string, AbortController>();
  private readonly activeMcpRequests = new Map<string, AbortController>();
  private readonly scheduledExecutions = new Set<string>();
  private readonly listeners = new Set<(event: AgentExecutionEvent) => void>();
  private readonly eventQueues = new Map<string, Promise<void>>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly resources: WorkspaceResourcesService,
    private readonly skillScripts: SkillScriptRunnerService,
    private readonly mcpRuntime: McpRuntimeService,
    private readonly builtinTools: BuiltinAgentToolsService,
  ) {}

  async create(request: Request, workspaceSlug: string, agentId: string, input: CreateAgentExecutionRequest): Promise<AgentExecutionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.requireExecutableAgent(workspace.id, agentId);
    const content = normalizeUserMessage(input?.message);
    const id = `aex_${randomUUID()}`;
    const now = new Date().toISOString();
    const modelMessages: StoredAgentModelMessage[] = [{ role: 'user', content }];
    const displayMessages: StoredAgentDisplayMessage[] = [{ id: `msg_${randomUUID()}`, role: 'user', content, createdAt: now }];
    await this.db.insert(agentExecutions).values({ id, workspaceId: workspace.id, agentId, status: 'running', phase: 'model', modelMessages, displayMessages });
    await this.publishSnapshotForExecution(workspace.id, id);
    this.schedule(request, workspaceSlug, id);
    return this.toView(await this.loadExecution(workspace.id, agentId, id));
  }

  async createBackgroundExecution(workspaceId: string, agentId: string, message: string): Promise<string> {
    const content = normalizeUserMessage(message);
    const id = `aex_${randomUUID()}`;
    const now = new Date();
    const modelMessages: StoredAgentModelMessage[] = [{ role: 'user', content }];
    const displayMessages: StoredAgentDisplayMessage[] = [{ id: `msg_${randomUUID()}`, role: 'user', content, createdAt: now.toISOString() }];
    await this.db.insert(agentExecutions).values({ id, workspaceId, agentId, status: 'running', phase: 'model', modelMessages, displayMessages, createdAt: now, updatedAt: now });
    await this.publishSnapshotForExecution(workspaceId, id);
    this.schedule({} as Request, 'personal', id);
    return id;
  }

  async executeWorkflowAgent(
    workspaceId: string,
    agentVersionId: string,
    input: unknown,
    promptTemplate: string | undefined,
    signal: AbortSignal,
    onTextDelta?: (delta: string) => void | Promise<void>,
  ): Promise<string> {
    const [version] = await this.db.select().from(agentVersions).where(and(eq(agentVersions.id, agentVersionId), eq(agentVersions.workspaceId, workspaceId))).limit(1);
    if (!version) throw new NotFoundException('Agent version not found');
    if (!version.providerId || !version.model) throw new ConflictException('The Agent version has no configured model provider.');
    const runtime = await this.resources.providerRuntime({} as Request, 'personal', version.providerId, version.model);
    const inputText = typeof input === 'string' ? input : JSON.stringify(input);
    const prompt = (promptTemplate?.trim() || '{{input}}').replaceAll('{{input}}', inputText);
    const result = await createModelGateway().generateAgentStep({
      provider: runtime.provider,
      model: runtime.model,
      systemPrompt: version.systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      skillScripts: [],
      maxToolRounds: 1,
      abortSignal: signal,
      onTextDelta,
    });
    if (result.toolCalls.length > 0) throw new BadRequestException('Workflow Agent nodes cannot request tools.');
    const output = result.text.trim();
    if (!output) throw new Error('The workflow Agent returned an empty response.');
    return output;
  }

  async get(request: Request, workspaceSlug: string, agentId: string, executionId: string): Promise<AgentExecutionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
  }

  async events(request: Request, workspaceSlug: string, agentId: string, executionId: string, afterSequence = 0): Promise<AgentExecutionEvent[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.loadExecution(workspace.id, agentId, executionId);
    const rows = await this.db.select().from(agentExecutionEvents)
      .where(and(eq(agentExecutionEvents.executionId, executionId), gt(agentExecutionEvents.sequence, afterSequence)))
      .orderBy(asc(agentExecutionEvents.sequence));
    return rows.map(toExecutionEvent);
  }

  subscribe(listener: (event: AgentExecutionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async continue(request: Request, workspaceSlug: string, agentId: string, executionId: string, input: ContinueAgentExecutionRequest): Promise<AgentExecutionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.requireExecutableAgent(workspace.id, agentId);
    const execution = await this.loadExecution(workspace.id, agentId, executionId);
    if (execution.status === 'running' || execution.status === 'waiting_for_input') throw new ConflictException(execution.status === 'waiting_for_input' ? 'Answer the pending Agent question before sending another message.' : 'This Agent execution is already running.');
    const content = normalizeUserMessage(input?.message);
    let accepted = false;
    this.db.transaction((transaction) => {
      const updated = transaction.update(agentExecutions).set({
        status: 'running',
        phase: 'model',
        errorCode: null,
        modelMessages: [...execution.modelMessages, { role: 'user', content }],
        displayMessages: [...execution.displayMessages, { id: `msg_${randomUUID()}`, role: 'user', content, createdAt: new Date().toISOString() }],
        error: null,
        updatedAt: new Date(),
      }).where(and(eq(agentExecutions.id, executionId), or(eq(agentExecutions.status, 'completed'), eq(agentExecutions.status, 'cancelled'), eq(agentExecutions.status, 'failed')))).run();
      accepted = updated.changes > 0;
    });
    if (!accepted) throw new ConflictException('This Agent execution is no longer ready for another message.');
    await this.publishSnapshotForExecution(workspace.id, executionId);
    this.schedule(request, workspaceSlug, executionId);
    return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
  }

  async retry(request: Request, workspaceSlug: string, agentId: string, executionId: string): Promise<AgentExecutionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.requireExecutableAgent(workspace.id, agentId);
    const execution = await this.loadExecution(workspace.id, agentId, executionId);
    if (execution.status !== 'failed') throw new ConflictException('Only a failed Agent execution can be retried.');
    const unresolvedCalls = await this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.resultAppended, false)));
    let accepted = false;
    const retryMessages: StoredAgentModelMessage[] = unresolvedCalls.length > 0
      ? [{ role: 'tool', content: unresolvedCalls.map((call) => ({ type: 'tool-result' as const, toolCallId: call.toolCallId, toolName: modelToolName(call), output: { type: 'error-text' as const, value: 'The previous tool attempt did not complete and was discarded before retry.' } })) }]
      : [];
    this.db.transaction((transaction) => {
      const updated = transaction.update(agentExecutions).set({ status: 'running', phase: 'model', errorCode: null, error: null, pendingQuestion: null, modelMessages: retryMessages.length > 0 ? [...execution.modelMessages, ...retryMessages] : execution.modelMessages, updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'failed'))).run();
      accepted = updated.changes > 0;
      if (accepted) {
        for (const call of unresolvedCalls) transaction.update(agentToolCalls).set({ status: 'failed', output: 'The previous tool attempt was discarded before retry.', resultAppended: true, finishedAt: new Date() }).where(and(eq(agentToolCalls.id, call.id), eq(agentToolCalls.resultAppended, false))).run();
      }
    });
    if (!accepted) throw new ConflictException('This Agent execution is no longer ready to retry.');
    await Promise.all(unresolvedCalls.flatMap((call) => call.commandExecutionId ? [this.skillScripts.cancel(call.commandExecutionId).catch(() => undefined)] : []));
    await this.publishSnapshotForExecution(workspace.id, executionId);
    this.schedule(request, workspaceSlug, executionId);
    return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
  }

  async answer(request: Request, workspaceSlug: string, agentId: string, executionId: string, input: AnswerAgentQuestionRequest): Promise<AgentExecutionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const execution = await this.loadExecution(workspace.id, agentId, executionId);
    if (execution.status !== 'waiting_for_input' || !execution.pendingQuestion || execution.pendingQuestion.id !== input?.questionId) throw new ConflictException('This Agent execution is not waiting for that question.');
    const answer = normalizeUserMessage(input?.answer);
    const pendingCall = (await this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.status, 'running'), eq(agentToolCalls.resultAppended, false))).limit(1))[0];
    if (!pendingCall) throw new ConflictException('The clarification request is no longer active.');
    const now = new Date();
    let accepted = false;
    this.db.transaction((transaction) => {
      const updated = transaction.update(agentExecutions).set({ status: 'running', phase: 'model', pendingQuestion: null, updatedAt: now }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'waiting_for_input'))).run();
      if (updated.changes === 0) return;
      accepted = true;
      transaction.update(agentToolCalls).set({ status: 'completed', output: answer, resultAppended: false, finishedAt: now }).where(and(eq(agentToolCalls.id, pendingCall.id), eq(agentToolCalls.status, 'running'))).run();
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId: workspace.id, action: 'agent_execution.question_answered', resource: executionId, metadata: { executionId, agentId, questionId: input.questionId } }).run();
    });
    if (!accepted) throw new ConflictException('This Agent question is no longer active.');
    await this.publishSnapshotForExecution(workspace.id, executionId);
    void this.resumeAfterToolCalls(request, workspaceSlug, workspace.id, agentId, executionId).catch(async (error) => {
      await this.markExecutionFailed(workspace.id, executionId, executionFailure(error));
    });
    return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
  }

  async cancel(request: Request, workspaceSlug: string, agentId: string, executionId: string): Promise<AgentExecutionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const execution = await this.loadExecution(workspace.id, agentId, executionId);
    if (execution.status !== 'running' && execution.status !== 'waiting_for_input') return this.toView(execution);

    const calls = await this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.resultAppended, false)));
    const runningCalls = calls.filter((call) => call.status === 'running');
    const toolResults = runningCalls.map((call) => ({
      type: 'tool-result' as const,
      toolCallId: call.toolCallId,
      toolName: modelToolName(call),
      output: { type: 'error-text' as const, value: 'The Skill script was cancelled by the user.' },
    }));
    const modelMessages: StoredAgentModelMessage[] = toolResults.length > 0
      ? [...execution.modelMessages, { role: 'tool', content: toolResults }]
      : execution.modelMessages;
    const cancelledAt = new Date();
    let cancelled = false;

    this.db.transaction((transaction) => {
      const result = transaction.update(agentExecutions).set({ status: 'cancelled', modelMessages, error: null, updatedAt: cancelledAt }).where(and(eq(agentExecutions.id, executionId), or(eq(agentExecutions.status, 'running'), eq(agentExecutions.status, 'waiting_for_input')))).run();
      if (result.changes === 0) return;
      cancelled = true;
      for (const call of runningCalls) {
        transaction.update(agentToolCalls).set({ status: 'cancelled', output: 'Skill execution cancelled.', resultAppended: true, finishedAt: cancelledAt }).where(and(eq(agentToolCalls.id, call.id), eq(agentToolCalls.status, 'running'))).run();
      }
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId: workspace.id, action: 'agent_execution.cancelled', resource: executionId, metadata: { agentId, commandExecutionIds: runningCalls.flatMap((call) => call.commandExecutionId ? [call.commandExecutionId] : []) } }).run();
    });

    if (cancelled) {
      this.activeModelRequests.get(executionId)?.abort();
      for (const call of runningCalls) this.activeMcpRequests.get(call.id)?.abort();
      await Promise.all(runningCalls.flatMap((call) => call.commandExecutionId
        ? [this.skillScripts.cancel(call.commandExecutionId).catch(() => undefined)]
        : []));
      await this.publishSnapshotForExecution(workspace.id, executionId);
    }
    return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
  }

  schedule(request: Request, workspaceSlug: string, executionId: string): void {
    if (this.scheduledExecutions.has(executionId)) return;
    this.scheduledExecutions.add(executionId);
    void this.advance(request, workspaceSlug, executionId)
      .catch(async (error) => {
        const workspace = await this.workspaces.getWorkspace(request, workspaceSlug).catch(() => null);
        if (workspace) await this.markExecutionFailed(workspace.id, executionId, executionFailure(error));
      })
      .finally(() => this.scheduledExecutions.delete(executionId));
  }

  private async advance(request: Request, workspaceSlug: string, executionId: string): Promise<AgentExecutionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [execution] = await this.db.select().from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.workspaceId, workspace.id))).limit(1);
    if (!execution) throw new NotFoundException('Agent execution not found');
    if (execution.status !== 'running') return this.toView(execution);
    const priorToolCalls = await this.db.select({ id: agentToolCalls.id, toolName: agentToolCalls.toolName, mcpToolName: agentToolCalls.mcpToolName }).from(agentToolCalls).where(eq(agentToolCalls.executionId, executionId));
    if (priorToolCalls.length >= MAX_HELPER_TOOL_ROUNDS) throw new Error('The Agent reached its maximum tool rounds for this execution.');
    const clarificationAllowed = execution.plan.length > 0
      && execution.plan.some((step) => step.status !== 'completed')
      && priorToolCalls.length === 1
      && priorToolCalls[0]?.toolName === 'builtin'
      && priorToolCalls[0].mcpToolName === 'update_plan';
    const { agent, assignedSkills } = await this.requireExecutableAgent(workspace.id, execution.agentId);
    const clarificationPass = agent.id === SYSTEM_HELPER_CHAT_ID && clarificationAllowed;
    const skillScripts = assignedSkills.flatMap((skill) => skill.files.filter((file) => file.path.startsWith('scripts/') && file.content.startsWith('#!')).map((file) => ({ skillId: skill.id, skillName: skill.name, path: file.path })));
    const mcpRuntimes = clarificationPass ? [] : await this.resources.agentMcpRuntimes(request, workspaceSlug, execution.agentId);
    const mcpTools = clarificationPass ? [] : await this.mcpRuntime.discover(mcpRuntimes);
    const availableSkillScripts = clarificationPass ? [] : skillScripts;
    const availableMcpTools = clarificationPass ? [] : mcpTools;
    const builtinToolDefinitions = agent.id === SYSTEM_HELPER_CHAT_ID
      ? clarificationPass ? HELPER_BUILTIN_TOOLS : [...this.builtinTools.toolDefinitions(), HELPER_BUILTIN_TOOLS[0]]
      : [];
    const skillInstructions = assignedSkills.map((skill) => `## ${skill.name}\n${skill.instructions.trim()}`).filter((value) => value.trim()).join('\n\n');
    const scriptList = availableSkillScripts.map((script) => `- Skill ${script.skillName} (${script.skillId}): ${script.path}`).join('\n');
    const systemPrompt = [
      agent.systemPrompt.trim(),
      skillInstructions ? `Assigned Skill instructions:\n\n${skillInstructions}` : '',
      availableSkillScripts.length > 0 ? 'Request at most one skill_script at a time. Every valid request executes immediately on the WorkLite host without user approval.' : '',
      scriptList ? `Assigned executable Skill scripts:\n${scriptList}\nUse skill_script only with an exact listed Skill id and script path.` : '',
      builtinToolDefinitions.length > 0 ? 'Use update_plan for multi-step work. Use ask_user only once in the clarification pass before execution when a material user choice is required.' : '',
      availableMcpTools.length > 0 ? `Assigned MCP tools:\n${availableMcpTools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    const abortController = new AbortController();
    this.activeModelRequests.set(executionId, abortController);

    try {
      await this.db.update(agentExecutions).set({ phase: 'model', updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running')));
      const readyExecution = await this.loadExecution(workspace.id, execution.agentId, executionId);
      if (readyExecution.status !== 'running') return this.toView(readyExecution);
      const runtime = await this.resources.providerRuntime(request, workspaceSlug, agent.providerId!, agent.model);
      const streamedMessageId = `msg_${randomUUID()}`;
      const result = await createModelGateway().generateAgentStep({ provider: runtime.provider, model: runtime.model, systemPrompt, messages: execution.modelMessages as GatewayAgentMessage[], skillScripts: availableSkillScripts, builtinTools: builtinToolDefinitions, mcpTools: availableMcpTools, maxToolRounds: MAX_HELPER_TOOL_ROUNDS, abortSignal: abortController.signal, onTextDelta: (delta) => this.persistEvent(executionId, { kind: 'message_delta', messageId: streamedMessageId, delta }) });
      const responseText = normalizeAssistantMessage(result.text);
      if (!responseText && result.toolCalls.length === 0) throw new Error('Empty Agent response');
      if (result.toolCalls.length > 4) throw new Error('The Agent requested too many tools in one step.');
      const currentExecution = await this.loadExecution(workspace.id, execution.agentId, executionId);
      if (currentExecution.status !== 'running') return this.toView(currentExecution);
      const modelMessages = [...execution.modelMessages, ...result.responseMessages] as StoredAgentModelMessage[];
      const displayMessages = responseText ? [...execution.displayMessages, { id: streamedMessageId, role: 'assistant' as const, content: responseText, createdAt: new Date().toISOString() }] : execution.displayMessages;
      let status: 'running' | 'waiting_for_input' | 'completed' = result.toolCalls.length > 0 ? 'running' : 'completed';
      let phase: AgentExecutionPhase = result.toolCalls.length > 0 ? 'skill' : 'model';
      let pendingQuestion: AgentPendingQuestion | null = null;
      let plan: AgentPlanStep[] = execution.plan ?? [];
      const runningCallIds: string[] = [];
      const immediateCallIds: string[] = [];
      let turnUpdated = false;

      this.db.transaction((transaction) => {
        const updated = transaction.update(agentExecutions).set({ status, phase, errorCode: null, modelMessages, displayMessages, plan, pendingQuestion, contextDropped: (execution.contextDropped ?? 0) + result.contextDropped, error: null, updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running'))).run();
        if (updated.changes === 0) return;
        turnUpdated = true;
        for (const requestedCall of result.toolCalls) {
          const callId = `acall_${randomUUID()}`;
          const workingDirectory = process.cwd();
          const skill = requestedCall.toolName === 'skill_script' ? assignedSkills.find((item) => item.id === requestedCall.skillId) : undefined;
          const script = skill?.files.find((file) => file.path === requestedCall.scriptPath && file.path.startsWith('scripts/') && file.content.startsWith('#!'));
          const mcpTool = mcpTools.find((tool) => tool.name === requestedCall.toolName);
          if (requestedCall.toolName === 'skill_script' && (!skill || !script)) throw new BadRequestException('The model requested a Skill script that is not assigned or executable.');
          if (requestedCall.toolName.startsWith('mcp_') && !mcpTool) throw new BadRequestException('The model requested an MCP tool that is not assigned or available.');
          if (clarificationPass && requestedCall.toolName !== 'update_plan' && requestedCall.toolName !== 'ask_user') throw new BadRequestException('Only clarification tools are available during the planning clarification pass.');
          if (requestedCall.toolName === 'ask_user') {
            if (!clarificationAllowed) throw new BadRequestException('The clarification tool is available only after a new multi-step plan and before execution begins.');
            if (result.toolCalls.length !== 1) throw new BadRequestException('The clarification tool must be requested in its own model step.');
            if (pendingQuestion) throw new BadRequestException('Only one clarification question may be active.');
            pendingQuestion = createPendingQuestion(requestedCall.input);
            status = 'waiting_for_input';
            phase = 'model';
          }
          if (requestedCall.toolName === 'update_plan') {
            plan = parsePlan(requestedCall.input);
            immediateCallIds.push(callId);
          } else if (requestedCall.toolName !== 'ask_user') {
            runningCallIds.push(callId);
          }
          transaction.insert(agentToolCalls).values({ id: callId, executionId, workspaceId: workspace.id, agentId: execution.agentId, toolCallId: requestedCall.toolCallId, toolName: requestedCall.toolName === 'skill_script' ? 'skill_script' : requestedCall.toolName.startsWith('mcp_') ? 'mcp' : 'builtin', workingDirectory, skillId: skill?.id ?? null, skillName: skill?.name ?? null, scriptPath: script?.path ?? null, mcpServerId: mcpTool?.serverId ?? null, mcpToolName: requestedCall.toolName.startsWith('mcp_') ? mcpTool?.remoteName ?? null : requestedCall.toolName, input: requestedCall.input, arguments: requestedCall.arguments ?? [], packageFiles: skill?.files ?? [], status: requestedCall.toolName === 'ask_user' ? 'running' : requestedCall.toolName === 'update_plan' ? 'completed' : 'running', output: requestedCall.toolName === 'update_plan' ? formatPlan(plan) : '' }).run();
          transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId: workspace.id, action: requestedCall.toolName === 'skill_script' ? 'skill_script.requested' : requestedCall.toolName === 'ask_user' ? 'agent_execution.question_requested' : `${requestedCall.toolName}.requested`, resource: callId, metadata: { agentId: execution.agentId, executionId, toolName: requestedCall.toolName, skillId: skill?.id ?? null, scriptPath: script?.path ?? null, mcpServerId: mcpTool?.serverId ?? null, mcpToolName: mcpTool?.remoteName ?? null } }).run();
        }
        transaction.update(agentExecutions).set({ status, phase, plan, pendingQuestion }).where(eq(agentExecutions.id, executionId)).run();
        if (status === 'completed') {
          transaction.update(agentSubSessions).set({ unread: true, updatedAt: new Date() }).where(eq(agentSubSessions.executionId, executionId)).run();
          transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId: workspace.id, action: 'agent_execution.completed', resource: executionId, metadata: { agentId: execution.agentId, executionId, phase: 'model', errorCode: null } }).run();
        }
      });
      if (turnUpdated) {
        for (const callId of [...immediateCallIds, ...runningCallIds]) {
          const [call] = await this.db.select().from(agentToolCalls).where(eq(agentToolCalls.id, callId)).limit(1);
          if (call) await this.persistEvent(executionId, { kind: 'tool_call', call: toToolCallView(call) });
        }
        await this.publishSnapshotForExecution(workspace.id, executionId);
      }
      if (turnUpdated && immediateCallIds.length > 0) {
        await this.resumeAfterToolCalls(request, workspaceSlug, workspace.id, execution.agentId, executionId);
      }
      if (turnUpdated && runningCallIds.length > 0) {
        void Promise.all(runningCallIds.map((callId) => this.executeToolCall(request, workspaceSlug, workspace.id, execution.agentId, executionId, callId))).catch(async () => {
          await this.markExecutionFailed(workspace.id, executionId, executionFailure(new Error('Skill execution failed')));
        });
      }
    } catch (error) {
      await this.markExecutionFailed(workspace.id, executionId, executionFailure(error));
    } finally {
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
      if (call.toolName === 'builtin') {
        if (!call.mcpToolName) throw new Error('Built-in tool is no longer available.');
        const started = await this.builtinTools.start(call.mcpToolName, call.input);
        commandExecutionId = started.id;
        const [linked] = await this.db.update(agentToolCalls).set({ commandExecutionId: started.id }).where(and(eq(agentToolCalls.id, callId), eq(agentToolCalls.status, 'running'))).returning({ id: agentToolCalls.id });
        const execution = await this.loadExecution(workspaceId, agentId, executionId);
        if (!linked || execution.status !== 'running') {
          await this.skillScripts.cancel(started.id).catch(() => undefined);
          return;
        }
        const completed = await this.skillScripts.wait(started.id);
        result = { status: completed.execution.status === 'cancelled' ? 'cancelled' : completed.execution.status === 'succeeded' ? 'completed' : 'failed', output: completed.output, result: null, exitCode: completed.execution.exitCode, commandExecutionId: completed.execution.id };
      } else if (call.toolName === 'mcp') {
        const runtimes = await this.resources.agentMcpRuntimes(request, workspaceSlug, agentId);
        const runtime = runtimes.find((item) => item.id === call.mcpServerId);
        if (!runtime || !call.mcpToolName) throw new Error('MCP tool is no longer available.');
        const abortController = new AbortController();
        this.activeMcpRequests.set(callId, abortController);
        const output = await this.mcpRuntime.call(runtime, call.mcpToolName, call.input, abortController.signal);
        if (this.activeMcpRequests.get(callId) === abortController) this.activeMcpRequests.delete(callId);
        result = { status: 'completed', output, result: null, exitCode: null, commandExecutionId: null };
      } else {
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
      }
    } catch {
      this.activeMcpRequests.delete(callId);
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
    if (finalized) {
      const [updatedCall] = await this.db.select().from(agentToolCalls).where(eq(agentToolCalls.id, callId)).limit(1);
      if (updatedCall) await this.persistEvent(executionId, { kind: 'tool_call', call: toToolCallView(updatedCall) });
      await this.publishSnapshotForExecution(workspaceId, executionId);
    }
    if (finalized && result.status !== 'cancelled') await this.resumeAfterToolCalls(request, workspaceSlug, workspaceId, agentId, executionId);
  }

  private async resumeAfterToolCalls(request: Request, workspaceSlug: string, workspaceId: string, agentId: string, executionId: string): Promise<AgentExecutionView> {
    const activeExecution = await this.loadExecution(workspaceId, agentId, executionId);
    if (activeExecution.status !== 'running') return this.toView(activeExecution);
    const calls = await this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.resultAppended, false)));
    if (calls.some((call) => call.status === 'running')) {
      await this.db.update(agentExecutions).set({ status: 'running', phase: 'skill', updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running')));
      await this.publishSnapshotForExecution(workspaceId, executionId);
      return this.toView(await this.loadExecution(workspaceId, agentId, executionId));
    }
    const execution = await this.loadExecution(workspaceId, agentId, executionId);
    const toolResults = calls.map((call) => ({ type: 'tool-result' as const, toolCallId: call.toolCallId, toolName: modelToolName(call), output: toolCallOutput(call) }));
    const modelMessages: StoredAgentModelMessage[] = [...execution.modelMessages, { role: 'tool', content: toolResults }];
    let shouldAdvance = false;
    this.db.transaction((transaction) => {
      const updated = transaction.update(agentExecutions).set({ status: 'running', phase: 'model', modelMessages, updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running'))).run();
      if (updated.changes === 0) return;
      shouldAdvance = true;
      for (const call of calls) transaction.update(agentToolCalls).set({ resultAppended: true }).where(eq(agentToolCalls.id, call.id)).run();
    });
    if (!shouldAdvance) return this.toView(await this.loadExecution(workspaceId, agentId, executionId));
    await this.publishSnapshotForExecution(workspaceId, executionId);
    return this.advance(request, workspaceSlug, executionId);
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
    return { id: execution.id, agentId: execution.agentId, status: execution.status, phase: execution.phase, errorCode: execution.errorCode, messages: execution.displayMessages, toolCalls: calls.map(toToolCallView), error: execution.error, plan: execution.plan ?? [], pendingQuestion: execution.pendingQuestion ?? null, contextDropped: execution.contextDropped ?? 0, createdAt: execution.createdAt.toISOString(), updatedAt: execution.updatedAt.toISOString() };
  }

  private async markExecutionFailed(workspaceId: string, executionId: string, failure: ExecutionFailure): Promise<void> {
    const now = new Date();
    this.db.transaction((transaction) => {
      const updated = transaction.update(agentExecutions).set({ status: 'failed', phase: failure.phase, errorCode: failure.code, error: failure.message, updatedAt: now }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running'))).run();
      if (updated.changes === 0) return;
      transaction.update(agentSubSessions).set({ unread: true, updatedAt: now }).where(eq(agentSubSessions.executionId, executionId)).run();
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId, action: 'agent_execution.failed', resource: executionId, metadata: { executionId, phase: failure.phase, errorCode: failure.code } }).run();
    });
    await this.publishSnapshotForExecution(workspaceId, executionId);
  }

  private async publishSnapshotForExecution(workspaceId: string, executionId: string): Promise<void> {
    const [execution] = await this.db.select().from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.workspaceId, workspaceId))).limit(1);
    if (!execution) return;
    const view = await this.toView(execution);
    await this.persistEvent(executionId, { kind: 'status', status: view.status, phase: view.phase, errorCode: view.errorCode, error: view.error });
    await this.persistEvent(executionId, { kind: 'snapshot', execution: view });
  }

  private async persistEvent(executionId: string, data: AgentExecutionEventData): Promise<void> {
    const previous = this.eventQueues.get(executionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const [row] = await this.db.insert(agentExecutionEvents).values({
        executionId,
        sequence: sql<number>`coalesce((select max(sequence) from agent_execution_events where execution_id = ${executionId}), 0) + 1`,
        data,
      }).returning();
      if (!row) return;
      const event = toExecutionEvent(row);
      for (const listener of this.listeners) listener(event);
    });
    this.eventQueues.set(executionId, next);
    try {
      await next;
    } finally {
      if (this.eventQueues.get(executionId) === next) this.eventQueues.delete(executionId);
    }
  }
}

function normalizeUserMessage(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw new BadRequestException('An Agent message is required.');
  return input.trim();
}

function normalizeAssistantMessage(input: string): string {
  const trimmed = input.trim();
  return /^\\+$/.test(trimmed) ? '' : input;
}

type ExecutionFailure = { message: string; code: AgentExecutionErrorCode; phase: AgentExecutionPhase };

function executionFailure(error: unknown): ExecutionFailure {
  if (error instanceof ModelGatewayError) {
    if (error.code === 'INCOMPLETE_TOOL_REQUEST') return { message: error.message, code: 'incomplete_tool_request', phase: 'model' };
    if (error.code === 'INVALID_TOOL_REQUEST') return { message: error.message, code: 'invalid_tool_request', phase: 'model' };
    if (error.code === 'INVALID_PROVIDER') return { message: 'The Agent provider configuration is invalid. Check the provider settings and try again.', code: 'provider', phase: 'model' };
    if (error.code === 'INVALID_REQUEST') return { message: error.message, code: 'invalid_request', phase: 'model' };
  }
  if (error instanceof Error && error.message === 'Skill execution failed') return { message: 'The Agent Skill script could not be completed.', code: 'skill', phase: 'skill' };
  return { message: 'The Agent could not complete this turn. Check its provider configuration and try again.', code: 'internal', phase: 'model' };
}

function toolCallOutput(call: typeof agentToolCalls.$inferSelect): GatewayToolResultOutput {
  const details = [`status=${call.status}`, `exitCode=${call.exitCode ?? 'none'}`, '', call.output || '(no output)'].join('\n');
  return call.status === 'completed' ? { type: 'text', value: details } : { type: 'error-text', value: details };
}

function modelToolName(call: typeof agentToolCalls.$inferSelect): string {
  if (call.toolName === 'builtin') return call.mcpToolName ?? 'builtin';
  if (call.toolName === 'mcp' && call.mcpServerId && call.mcpToolName) return `mcp_${call.mcpServerId}_${call.mcpToolName}`;
  return call.toolName;
}

function toToolCallView(call: typeof agentToolCalls.$inferSelect): AgentToolCallView {
  return { id: call.id, workingDirectory: call.workingDirectory, skillId: call.skillId, skillName: call.skillName, scriptPath: call.scriptPath, mcpServerId: call.mcpServerId, mcpToolName: call.mcpToolName, arguments: call.arguments, status: call.status, output: call.output, exitCode: call.exitCode, commandExecutionId: call.commandExecutionId, result: call.result, createdAt: call.createdAt.toISOString(), finishedAt: call.finishedAt?.toISOString() ?? null };
}

function toExecutionEvent(row: typeof agentExecutionEvents.$inferSelect): AgentExecutionEvent {
  return {
    sequence: row.sequence,
    executionId: row.executionId,
    data: row.data as AgentExecutionEventData,
    createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
  };
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

function parsePlan(input: unknown): AgentPlanStep[] {
  const record = asRecord(input);
  const steps = record?.steps;
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 8) throw new BadRequestException('The Agent plan must contain between 2 and 8 steps.');
  const normalized = steps.map((value) => {
    const step = asRecord(value);
    const text = typeof step?.step === 'string' ? step.step.trim() : '';
    const status = step?.status;
    if (!text || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) throw new BadRequestException('The Agent plan contains an invalid step.');
    return { step: text, status } as AgentPlanStep;
  });
  if (normalized.filter((step) => step.status === 'in_progress').length > 1) throw new BadRequestException('The Agent plan may have only one in-progress step.');
  return normalized;
}

function formatPlan(plan: AgentPlanStep[]): string {
  return plan.map((step) => `${step.status === 'completed' ? '[done]' : step.status === 'in_progress' ? '[active]' : '[pending]'} ${step.step}`).join('\n');
}

function createPendingQuestion(input: unknown): AgentPendingQuestion {
  const record = asRecord(input);
  const question = typeof record?.question === 'string' ? record.question.trim() : '';
  const options = Array.isArray(record?.options) ? record.options.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map((value) => value.trim()) : [];
  if (!question) throw new BadRequestException('The Agent question must include text.');
  return { id: `question_${randomUUID()}`, question, options, createdAt: new Date().toISOString() };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
