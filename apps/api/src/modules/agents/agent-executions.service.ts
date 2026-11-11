import { DISCOVER_CHAT_TOOLS, NATIVE_CHAT_TOOL_GUIDANCE, discoverChatTools, loadedChatToolNames, nativeChatTurnKey, nativeChatInstructions, visibleChatTools } from './native-chat-tools';
import type { ModelParameters } from '@worklite/contracts';
import { encodeMessageState, patchExecutionMessages, appendExecutionMessages, executionUpdates, agentExecutionColumns, displayMessagesColumn, projectTaskColumns, platformArgumentsHash, CHAT_DELEGATION_RULE, agentCapabilityResults, agentExecutionEvents, agentExecutions, chatConfigurations, chatMemories, agents, agentSkills, agentMcpServers, mcpServers, agentRuntimeSessions, agentSubSessions, agentToolCalls, auditLogs, chatProjectTasks, chatSubmissions, externalChats, skillFiles, skills, type Database, type StoredAgentDisplayMessage, type StoredAgentModelMessage, insertAgentToolResults, normalizeAgentModelMessages } from '@worklite/db';

import { StreamBatch } from '../../infrastructure/stream-batch';

import { localImageToolOutput } from './local-image-tool-result';
import { agentFiles } from './agent-file-store';

import { platformFailure, platformInputIssues, platformContractHash, scriptFailure, type PlatformFailure } from './platform-failure';
import { chatContextBudget, compactNativeContext, isContextLimitError, COMPACTION_SYSTEM_PROMPT } from './native-context';
import { NativeAgentLoop } from './native-agent-loop';
import { nativeToolPolicy } from './native-tool-policy';
import { agentInvocationDisplays } from './agent-invocation-display';
import { activeChatBackgroundExecutionIds, chatConversationStatus } from './chat-conversation-status';
import { AgentCollaborationService, CHAT_AGENT_TOOLS } from './agent-collaboration.service';
import { assertRuntimeAdmission } from '../../infrastructure/runtime-upgrade-state';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import type { Request } from 'express';
import type { AgentExecutionEvent, AgentExecutionEventData, AgentExecutionPhase, AgentExecutionView, AgentPendingQuestion, AgentPlanStep, AgentToolCallView, AnswerAgentQuestionRequest, ChatProgressReport, ChatProjectTaskView, ChatTaskReference, ContinueAgentExecutionRequest, CreateAgentExecutionRequest, ModelProviderProtocol, WorkflowNodeActivityDetail, WorkliteScriptResult } from '@worklite/contracts';
import { agentTaskDisplayText, CHAT_TURN_NOTIFICATION_DEFAULT_SOUND, WORKLITE_PLATFORM_SKILL_NAME } from '@worklite/contracts';

import { createModelGateway, estimateModelCost, type GatewayAgentMessage, type GatewayToolDefinition, type GatewayToolResultOutput, type ModelUsage } from '@worklite/model-gateway';
import type { AgentExecutionUsage } from '@worklite/contracts';
import type { StoredAgentExecutionUsage } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { SkillScriptRunnerService } from '../skills/skill-script-runner.service';
import { localSkillId, skillDirectoryName } from '../skills/local-skill-source';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { isWorkliteNavigationTarget, resolveWorkliteNavigationRoute } from '../teams/worklite-navigation';
import { WorkspaceService } from '../teams/teams.service';
import { McpRuntimeService } from './mcp-runtime.service';
import { BuiltinAgentToolsService } from './builtin-agent-tools.service';
import { IsolatedAgentInvocationService } from './isolated-agent-invocation.service';
import { decryptSecret } from '../connections/connection-secrets';
import { ChatProjectTasksService } from './chat-project-tasks.service';
import { ChatAttachmentsService } from './chat-attachments.service';
import { inlineUserAttachmentImages } from './chat-model-images';
import { buildChatMemoriesPrompt } from './chat-memories.service';
import { ClaudeCodeError } from './claude-code.service';
import { CodexAppServerError } from './codex-app-server.service';
import { AgentRuntimeService } from './agent-runtime.service';
import { validateAgentRuntime } from './agent-runtime.configuration';
import { CommandsService } from '../commands/commands.service';
import { executionFailure, executionFailureSource, type ExecutionFailure } from './agent-execution-failure';
import { ChatHostCommandService, type ChatHostCommandResult } from './chat-host-command.service';
import { HostNotificationsService } from '../notifications/host-notifications.service';

const CHAT_AGENT_ID = 'agt_system_helper_chat';

const CHAT_HOST_COMMAND_RULE = 'Use run_host_command for everyday non-interactive local terminal work and ordinary file management. Directly author Agent-owned Skills, Tools and their local scripts as configuration work. Delegate other coding, repository-wide investigation and validation/build/test work to an appropriate Agent with run_agent and the existing absolute projectDirectory. There is no command allow-list.';
const CHAT_ROUTER_CONTROL_RULE = 'All delegated work uses Agents. Inspect available Agents and select by current id and responsibility. A native lead Agent dynamically coordinates assigned sub-Agents. There are no Coding Teams, Coders, fixed role workflows or server-owned Router.';
const CHAT_ORCHESTRATION_RULE = 'Only top-level user-managed Agents belong to the user-facing Agent catalog and count. Sub-Agents are private to their owning Agent; never list, count or dispatch them as independent Agents from Chat. Chat may read, update or delete them only through GET/PATCH/DELETE /agents/:parentId/sub-agents/:childId. Deleting an Agent cascades through all its descendants in one operation; never require manually deleting children first. There is no built-in Agent or Team product concept; do not use these categories. Answer Agent count questions with only the count and names requested. For requests to add or change an Agent-owned ability, inspect its package and use run_host_command to write skills/<name>/SKILL.md, tools/<name>.yaml and their implementation scripts directly. This is Chat-owned configuration work, not delegated repository coding. Use the actual catalog root supplied in this turn; identify the target by AGENT.md id and directory ownership. Do not use update_agent or platform capability registration to install private abilities. Preserve unrelated files and read back the changes; use read-only query_platform GET for the Agent to validate loading before reporting success. New invocations load these files without deployment or API restart. update_agent remains available for metadata/model settings. run_agent starts independent background work and returns a launch receipt immediately; the conversation stays available and results are reported automatically. Do not wait or poll for delegated results. The UI renders each dispatch as a task card with @Agent and the task summary on its first line, the current step below and execution status at the right. Successful dispatch-only batches end the Chat turn with this card and no generated launch acknowledgement. For a WeChat-bound conversation, the platform also queues one immediate short plain-text notice containing the Agent name and task summary after accepting each dispatch; never generate a duplicate acknowledgement. WeChat later receives changed periodic progress, questions and final results as text; failed dispatches and batches containing other operations retain normal follow-up. Periodic Agent progress cards include the task summary in the same layout. Do not narrate dispatches before or after run_agent, repeat their acknowledgement or invent duration estimates. Chat understands the user goal, performs platform operations and everyday terminal work directly, and uses inspect_agents plus run_agent for delegated work, code changes and multi-step project tasks. A user mention selects a target, not an action. First decide whether the user asks for information, control, new work, or continuation. For status, progress or failure explanations, read saved records and answer without waking an Agent. For stop/cancel requests, use cancel_agent_execution with the exact agentId and executionId; include runId only to stop one child invocation and its descendants. Never dispatch work to stop it. For independent work use run_agent mode=new, even for the same Agent or project; pass only necessary background. For an explicit continuation, correction or missing input for the same task, use mode=continue with the exact executionId and continuationReason. An instance mention may identify that task but does not by itself authorize continuation. If multiple tasks match, ask which one. Cancelled tasks require an explicit user request to resume and resumeCancelled=true. When the user requests continuing or modifying a known earlier task, reuse its executionId from its launch receipt or result report; never create a replacement instance or guess among multiple tasks. Completed, failed and cancelled native Agent instances can continue with their saved model history and tool evidence; cancellation does not delete the instance. For a requested pause or resume of one active execution sub-Agent, read the lead history to find its exact child runId and use control_agent_instance with the owning Agent id, executionId and that runId. Do not cancel the lead, dispatch replacement work or affect sibling instances. Controls require a saved engine session and a live owning execution; they do not survive an API restart. For a user-requested model change followed by continuation, inspect the Agent configuration, update and verify its configured model (collaboration.publicModels for Gateway models, or providerId/model for provider-backed Agents), then call run_agent with the original executionId. Native Agent continuation reads the latest saved configuration; never claim it requires starting over or loses context. Do not promise this model-switch behavior for engine-backed sessions, whose captured runtime may remain fixed. For an explicit new direction on a running instance, use mode=continue with the same executionId: the platform interrupts its current turn and resumes its saved session. waiting_for_input requires answering its pending question first. Continuation does not blindly replay tools or uncertain external effects. When asked what an Agent is doing, read its current run detail on demand: GET /agents/:agentId/history/:runId includes currentActivity, invocation states and partial output. Distinguish current tool work, model generation and waiting for input using recorded evidence, and do not invent progress or claim partial output is final. The Agent run-record UI refreshes the detail every two seconds and expands active sub-Agent records. A user-requested status check is allowed; do not turn it into repeated polling. Keep the mention link intact; it opens the corresponding work detail. Honor explicit Agent targets. Use search_local_projects to resolve project names, and pass an absolute existing projectDirectory for code or file work. The lead Agent chooses sub-Agents, ordering, independent parallel work and retries from actual results. No Workflow or Coding Team APIs remain. Ask only when a material choice or missing information blocks work. Report actual results and failures, never assume delegated work succeeded. For redeploy-only use redeploy directly. For code changes plus redeployment, run the selected Agent with the complete goal and managed project root, then redeploy after success without another confirmation. Keep task-produced attachment references verbatim.';
// A settled Chat turn posts one macOS host notification so the user knows to come back. The subtitle
// names the terminal state; the body carries the short context that tells them what it is about.
const CHAT_TURN_NOTIFICATION_TITLE = 'WorkLite';
const CHAT_TURN_NOTIFICATION_SUBTITLES = { completed: '对话完成', failed: '对话失败', waiting_for_input: '需要你的输入' } as const;
const MAX_TRACKED_NOTIFIED_TURNS = 500;

const MAX_HELPER_TOOL_ROUNDS = 24;
// A research node batches several retrieval calls per turn and still needs turns left to compose its
// output. Eight rounds exhausted before collection finished; the retrieval allowance is enforced by the
// Skill scripts themselves, so a higher ceiling here bounds runaway looping without capping real work.

type WorkflowAgentActivityReporter = (detail: Extract<WorkflowNodeActivityDetail, { phase: 'model.round' | 'skill.script' | 'mcp.call' }>) => void | Promise<void>;
// A model response may legitimately batch independent calls: changing every role of a Coder to
// one model is one call per role, so an ordinary request arrives as eight calls in one step.
// The runtime treats anything past this per-step ceiling as a deferred
// call with an explanatory tool result. Reaching the ceiling is a model mistake the next step can
// correct; it must never fail the whole turn and strand the conversation.
const MAX_TOOL_CALLS_PER_STEP = 16;
// Sent for this one request only, never stored: the turn's history keeps its real messages.
const TOOL_BUDGET_EXHAUSTED_MESSAGE = 'The tool budget for this turn is exhausted, so no tools are available now. Reply to the user with what you found so far, say plainly what is still unverified, and explain the likely blocking cause supported by the evidence. Distinguish facts from hypotheses; do not keep repeating searches, retry automatically or claim success.';
const DEFERRED_TOOL_CALL_OUTPUT = 'This tool call was not executed: the model response contained more tool calls than one step allows. Reissue this call in a later step.';

export type ToolCallAdmission = {
  index: number;
  total: number;
  toolName: string;
  chatOnly: boolean;
  hasBuiltinTool: boolean;
  hasSkill: boolean;
  hasScript: boolean;
  hasMcpTool: boolean;
  clarificationPass: boolean;
  projectTaskWithOtherTools: boolean;
  pendingQuestion: boolean;
};

// Returns the model-facing reason a requested call is not executed, or null to run it. A reason
// is a normal tool result the model can act on, never an execution failure.
export function toolCallRejection(input: ToolCallAdmission): string | null {
  if (input.index >= MAX_TOOL_CALLS_PER_STEP) return DEFERRED_TOOL_CALL_OUTPUT;
  if (input.chatOnly && input.toolName !== 'skill_script' && !input.hasBuiltinTool) return 'Chat may only dispatch tasks and use protected platform operations.';
  if (input.toolName === 'skill_script' && (!input.hasSkill || !input.hasScript)) return 'The model requested a Skill script that is not assigned or executable.';
  if (input.toolName.startsWith('mcp_') && !input.hasMcpTool) return 'The model requested an MCP tool that is not assigned or available.';
  if (input.clarificationPass && input.toolName !== 'update_plan' && input.toolName !== 'ask_user') return 'Only clarification tools are available during the planning clarification pass.';
  // A plan update settles immediately, so it may accompany the one project task it describes.
  if (input.toolName === 'project_task' && input.projectTaskWithOtherTools) return '一次模型响应只能派发一个 project_task（可同时更新计划）。若一个目标涉及多个项目，请将共同工作区根目录作为单个任务目录重新派发；独立任务请分开派发。';
  if (input.toolName === 'ask_user' && !input.chatOnly) return 'Only Chat may ask a conversation question.';
  if (input.toolName === 'ask_user' && input.total !== 1) return 'The clarification tool must be requested in its own model step.';
  if (input.toolName === 'ask_user' && input.pendingQuestion) return 'Only one clarification question may be active.';
  return null;
}


const HISTORY_ARCHIVE_TOOL: GatewayToolDefinition = {
  name: 'read_history_archive', executionMode: 'parallel',
  description: 'Read a bounded page of original conversation history archived before automatic context compaction. Use the exact archiveId from a checkpoint when original tool evidence or instructions are needed.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['archiveId'], properties: { archiveId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 12000 } } },
};

const HELPER_BUILTIN_TOOLS = [
  {
    name: 'update_plan',
    description: 'Create or update the complete execution plan for a multi-step task.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['steps'], properties: { explanation: { type: 'string' }, steps: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['step', 'status'], properties: { step: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } } } } } },
  },
  {
    name: 'ask_user',
    description: 'Ask one question when a material user choice or missing information blocks the current request. Offer relevant options when useful. Project executors run clear user tasks directly without WorkLite confirmation or command grants. A plan is not required for ordinary dialogue.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['question'], properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, action: { type: 'string', enum: ['new_conversation'] } } },
  },
] as const;

type AcceptanceTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type ConversationAcceptance = (transaction: AcceptanceTransaction, executionId: string, previous?: AgentExecutionView) => void;

// The columns toView reads. modelMessages and capabilitySnapshot carry the largest JSON payloads
// on the row and are excluded so view loads never parse them.
const agentExecutionViewColumns = {
  queuedMessages: agentExecutions.queuedMessages,
  workspaceId: agentExecutions.workspaceId,
  executionAuthorization: agentExecutions.executionAuthorization,
  id: agentExecutions.id,
  agentId: agentExecutions.agentId,
  status: agentExecutions.status,
  phase: agentExecutions.phase,
  errorCode: agentExecutions.errorCode,
  displayMessages: displayMessagesColumn,
  plan: agentExecutions.plan,
  pendingQuestion: agentExecutions.pendingQuestion,
  contextDropped: agentExecutions.contextDropped,
  usage: agentExecutions.usage,
  error: agentExecutions.error,
  createdAt: agentExecutions.createdAt,
  updatedAt: agentExecutions.updatedAt,
} as const;
type AgentExecutionViewRow = Pick<typeof agentExecutions.$inferSelect, keyof typeof agentExecutionViewColumns>;

function executionUsageView(usage: StoredAgentExecutionUsage | undefined): AgentExecutionUsage | undefined {
  if (!usage || !usage.requests) return undefined;
  return {
    requests: usage.requests, inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0, cacheReadTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    costUsd: usage.costUsd ?? null,
  };
}

function accumulateExecutionUsage(previous: StoredAgentExecutionUsage, usage: ModelUsage, model: string): StoredAgentExecutionUsage {
  const cost = estimateModelCost(model, usage);
  const previousCost = previous.requests ? previous.costUsd ?? null : 0;
  return {
    requests: (previous.requests ?? 0) + 1,
    inputTokens: (previous.inputTokens ?? 0) + (usage.inputTokens ?? 0),
    outputTokens: (previous.outputTokens ?? 0) + (usage.outputTokens ?? 0),
    reasoningTokens: (previous.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
    cacheReadTokens: (previous.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: (previous.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    costUsd: previousCost === null || cost === null ? null : previousCost + cost,
    lastInputTokens: usage.inputTokens ?? previous.lastInputTokens,
    model,
  };
}

@Injectable()
export class AgentExecutionsService implements OnModuleInit {
  private readonly nativeLoop = new NativeAgentLoop();
  private readonly nativeToolProgress = new Map<string, (text: string) => Promise<void>>();
  private readonly activeNativeBatches = new Map<string, AbortController>();
  private readonly logger = new Logger(AgentExecutionsService.name);
  private readonly activeModelRequests = new Map<string, AbortController>();
  private readonly activeMcpRequests = new Map<string, AbortController>();
  private readonly activeHostCommands = new Map<string, AbortController>();
  private readonly scheduledExecutions = new Map<string, Promise<void>>();
  private readonly continuationQueues = new Map<string, Promise<AgentExecutionView>>();
  private readonly pendingContinuations = new Map<string, Set<AbortController>>();
  private readonly listeners = new Set<(event: AgentExecutionEvent) => void>();
  private readonly textBatches = new Map<string, StreamBatch<Extract<AgentExecutionEventData, { kind: 'message_delta' }>>>();
  private readonly eventQueues = new Map<string, Promise<void>>();
  // Terminal state already notified per conversation, so one settled turn posts exactly one
  // notification however many snapshots that turn publishes. A new turn clears its entry.
  private readonly notifiedTurnStates = new Map<string, string>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly resources: WorkspaceResourcesService,
    private readonly skillScripts: SkillScriptRunnerService,
    private readonly mcpRuntime: McpRuntimeService,
    private readonly builtinTools: BuiltinAgentToolsService,
    private readonly commands: CommandsService,
    private readonly invocations: IsolatedAgentInvocationService,
    private readonly projectTasks: ChatProjectTasksService,
    private readonly attachments: ChatAttachmentsService,
    private readonly hostCommands: ChatHostCommandService,
    private readonly hostNotifications: HostNotificationsService,
    private readonly agentRuntime: AgentRuntimeService,
    private readonly collaboration?: AgentCollaborationService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.scheduleBackgroundAgentReports();
    const retired = await this.db.select({ executionId: auditLogs.resource, workspaceId: auditLogs.workspaceId }).from(auditLogs)
      .where(eq(auditLogs.action, 'chat_execution.question_retired')).groupBy(auditLogs.resource, auditLogs.workspaceId);
    const interrupted = this.db.select({ executionId: agentRuntimeSessions.id, workspaceId: agentRuntimeSessions.workspaceId }).from(agentRuntimeSessions).where(eq(agentRuntimeSessions.status, 'interrupted')).all();
    for (const entry of [...retired, ...interrupted]) {
      const [execution] = await this.db.select(agentExecutionColumns).from(agentExecutions).where(and(eq(agentExecutions.id, entry.executionId), eq(agentExecutions.workspaceId, entry.workspaceId))).limit(1);
      if (!execution) continue;
      const [latest] = await this.db.select({ data: agentExecutionEvents.data }).from(agentExecutionEvents)
        .where(and(eq(agentExecutionEvents.executionId, execution.id), eq(agentExecutionEvents.kind, 'snapshot'))).orderBy(desc(agentExecutionEvents.sequence)).limit(1);
      const snapshot = latest?.data as AgentExecutionEventData | undefined;
      if (snapshot?.kind === 'snapshot' && snapshot.execution.status === execution.status && snapshot.execution.updatedAt === execution.updatedAt.toISOString()) continue;
      await this.publishSnapshotForExecution(entry.workspaceId, execution.id);
    }
    for (const task of this.projectTasks.unreportedSettled()) {
      this.scheduleProjectTaskReport(task.workspaceId, task.executionId, task.id, 5000);
    }
    // Interrupted mid-merge tasks are reconciled first so their checkout is usable, then their
    // failure reports run through the ordinary sweep above on the next boot; subscriptions of
    // already-settled tasks are scheduled here.
    await this.projectTasks.reconcileInterruptedMerges().catch((error) => this.logger.warn(`Worktree merge reconciliation failed: ${error instanceof Error ? error.message : String(error)}`));
    for (const pending of this.projectTasks.pendingSubscriptionReports()) {
      this.scheduleSubscriptionReport(pending.task.workspaceId, pending.subscriberExecutionId, pending.task.id, pending.subscriptionId, 5000);
    }
  }

  async create(request: Request, workspaceSlug: string, agentId: string, input: CreateAgentExecutionRequest, accept?: ConversationAcceptance): Promise<AgentExecutionView> {
    assertRuntimeAdmission();
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.resources.reconcileWorkspaceSkills(workspace.id);
    const { agent } = await this.requireExecutableAgent(workspace.id, agentId);
    const projectDirectory = agentId === CHAT_AGENT_ID ? null : input?.projectDirectory?.trim() || null;
    if (agentId !== CHAT_AGENT_ID && projectDirectory) await validateAgentRuntime({ kind: 'claude', projectDirectory });
    if (agentId !== CHAT_AGENT_ID && agent.runtime.kind !== 'native') {
      const runtime = await validateAgentRuntime({ ...agent.runtime, projectDirectory: projectDirectory || agent.runtime.projectDirectory });
      if (runtime.kind !== 'native' && !runtime.projectDirectory) throw new BadRequestException('runtime.projectDirectory is required for this Agent; configure it or pass projectDirectory to run_agent.');
    }
    const content = normalizeUserMessage(input?.message);
    const id = `aex_${randomUUID()}`;
    const now = new Date().toISOString();
    const modelMessages: StoredAgentModelMessage[] = [{ role: 'user', content }];
    const displayMessages: StoredAgentDisplayMessage[] = [{ id: `msg_${randomUUID()}`, role: 'user', content: agentTaskDisplayText(content), createdAt: now }];
    this.db.transaction((transaction) => {
      transaction.insert(agentExecutions).values({ id, workspaceId: workspace.id, agentId, projectDirectory, capabilitySnapshot: this.captureCapabilities(transaction, workspace.id, agentId), status: 'running', phase: 'model', modelMessages, displayMessages }).run();
      accept?.(transaction, id);
    });
    await this.publishSnapshotForExecution(workspace.id, id);
    this.schedule(request, workspaceSlug, id);
    return this.toView(await this.loadExecution(workspace.id, agentId, id));
  }

  async startNewConversation(request: Request, workspaceSlug: string, executionId: string, questionId: string, accept: ConversationAcceptance): Promise<AgentExecutionView> {
    assertRuntimeAdmission();
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const id = `aex_${randomUUID()}`;
    const now = new Date();
    this.db.transaction((transaction) => {
      const previous = transaction.select(agentExecutionColumns).from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.workspaceId, workspace.id), eq(agentExecutions.agentId, CHAT_AGENT_ID))).get();
      if (previous?.status !== 'waiting_for_input' || previous.pendingQuestion?.id !== questionId || previous.pendingQuestion.action !== 'new_conversation') throw new ConflictException('This new-conversation action is no longer active.');
      const pending = transaction.select().from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.mcpToolName, 'ask_user'), eq(agentToolCalls.status, 'running'), eq(agentToolCalls.resultAppended, false))).get();
      if (!pending) throw new ConflictException('This conversation question is no longer active.');
      transaction.update(agentToolCalls).set({ status: 'completed', resultAppended: true, output: '已开启新对话。', finishedAt: now }).where(eq(agentToolCalls.id, pending.id)).run();
      transaction.update(agentExecutions).set(executionUpdates(executionId, { status: 'completed', pendingQuestion: null, updatedAt: now, modelMessages: appendExecutionMessages(executionId, 'model', [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: pending.toolCallId, toolName: 'ask_user', output: { type: 'text', value: 'The user started a new conversation.' } }] }]) })).where(eq(agentExecutions.id, executionId)).run();
      transaction.insert(agentExecutions).values({ id, workspaceId: workspace.id, agentId: CHAT_AGENT_ID, status: 'completed', phase: 'model', modelMessages: [], displayMessages: [{ id: `msg_${randomUUID()}`, role: 'assistant', content: '已开启新对话。', createdAt: now.toISOString() }] }).run();
      accept(transaction, id);
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId: workspace.id, action: 'chat.new_conversation', resource: id, metadata: { previousExecutionId: executionId, questionId } }).run();
    });
    await this.publishSnapshotForExecution(workspace.id, executionId);
    this.activeModelRequests.get(executionId)?.abort(new Error('The user started a new conversation.'));
    await this.agentRuntime.waitForStop(executionId);
    await this.publishSnapshotForExecution(workspace.id, id);
    return this.toView(await this.loadExecution(workspace.id, CHAT_AGENT_ID, id));
  }

  /** Validates a one-off Workflow Agent model without changing the saved Workflow. */
  async assertPublicAgentModel(publicModelId: string): Promise<void> {
    return this.resources.assertPublicAgentModel(publicModelId);
  }

  /** Canonicalizes Workflow Agent Skill ids the same way executeWorkflowAgent does. */
  async resolveWorkflowSkillIds(workspaceId: string, skillIds: readonly string[]): Promise<string[]> {
    return this.resources.resolveSkillIds(workspaceId, skillIds);
  }

  async executeWorkflowAgent(
    workspaceId: string,
    // One declared public model id, or an ordered list of fallback candidates.
    model: string | readonly string[],
    context: unknown,
    systemPrompt: string,
    requestedSkillIds: string[],
    requestedMcpServerIds: string[],
    signal: AbortSignal,
    onTextDelta?: (delta: string) => void | Promise<void>,
    jsonOutput = false,
    activity?: WorkflowAgentActivityReporter,
    correlation?: { workflowId: string; workflowRunId: string; nodeRunId: string },
    limits?: { maxToolCalls?: number; maxToolRounds?: number; maxToolResultChars?: number; maxOutputTokens?: number },
    modelParameters?: ModelParameters,
  ): Promise<string> {
    const selectedSkillIds = await this.resources.resolveSkillIds(workspaceId, requestedSkillIds);
    const skillRows = selectedSkillIds.length === 0
      ? []
      : await this.db.select({ id: skills.id, name: skills.name, root: skills.root, instructions: skills.instructions, validation: skills.validation, validationReason: skills.validationReason }).from(skills).where(and(eq(skills.workspaceId, workspaceId), inArray(skills.id, selectedSkillIds)));
    if (skillRows.length !== selectedSkillIds.length) throw new NotFoundException('A Workflow Agent Skill is no longer available.');
    const nonPlatformSkill = skillRows.find((skill) => skill.root !== 'platform');
    if (nonPlatformSkill) throw new BadRequestException(`Workflow Agent Skill ${nonPlatformSkill.name} is not a WorkLite platform Skill.`);
    const invalidSkill = skillRows.find((skill) => skill.validation !== 'valid');
    if (invalidSkill) throw new BadRequestException(invalidSkill.validationReason ?? `Workflow Agent Skill ${invalidSkill.name} is invalid.`);
    const files = selectedSkillIds.length === 0 ? [] : await this.db.select().from(skillFiles).where(inArray(skillFiles.skillId, selectedSkillIds));
    const assignedSkills = skillRows.map((skill) => ({
      id: skill.id,
      name: skill.name,
      instructions: skill.instructions,
      files: files.filter((file) => file.skillId === skill.id).map(({ path, content }) => ({ path, content })),
    }));
    const mcpRuntimes = await this.resources.workflowMcpRuntimes(workspaceId, requestedMcpServerIds);
    return this.invocations.execute({
      workspaceId,
      publicModelId: model,
      modelParameters,
      systemPrompt,
      context,
      skills: assignedSkills,
      mcpRuntimes,
      builtinToolNames: [],
      signal,
      onTextDelta,
      onModelRound: activity ? async (round) => activity({ phase: 'model.round', ...round }) : undefined,
      onSkillScript: activity ? async (detail) => activity({ phase: 'skill.script', ...detail }) : undefined,
      onMcpCall: activity ? async (detail) => activity({ phase: 'mcp.call', ...detail }) : undefined,
      jsonOutput,
      correlation: correlation ? { surface: 'workflow', ...correlation } : undefined,
      limits,
    });
  }

  async get(request: Request, workspaceSlug: string, agentId: string, executionId: string): Promise<AgentExecutionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return this.toView(await this.loadExecutionView(workspace.id, agentId, executionId));
  }

  async readHistoryArchive(request: Request, workspaceSlug: string, agentId: string, executionId: string, resultRef: string, offset = 0, maxChars = 12000) {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.loadExecutionView(workspace.id, agentId, executionId);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 12000) throw new BadRequestException('Invalid history page.');
    const row = this.db.select().from(agentCapabilityResults).where(and(eq(agentCapabilityResults.id, resultRef), eq(agentCapabilityResults.executionId, executionId))).get();
    if (!row || !['task-checkpoint', 'conversation-history', 'native-context'].includes(String(asRecord(row.value)?.kind))) throw new NotFoundException('History archive not found.');
    const text = JSON.stringify(row.value);
    return { text: text.slice(offset, offset + maxChars), totalChars: text.length, nextOffset: offset + maxChars < text.length ? offset + maxChars : null };
  }

  async historyArchive(request: Request, workspaceSlug: string, agentId: string, executionId: string, archiveId: string, offset = 0, maxChars = 12000) {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return this.readNativeHistoryArchive(workspace.id, agentId, executionId, archiveId, offset, maxChars);
  }

  private readNativeHistoryArchive(workspaceId: string, agentId: string, executionId: string, archiveId: string, offset: number, maxChars: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 12000) throw new BadRequestException('Invalid archive page.');
    const owner = this.db.select({ id: agentExecutions.id }).from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.agentId, agentId), eq(agentExecutions.workspaceId, workspaceId))).get();
    if (!owner) throw new NotFoundException('Agent execution not found');
    const archive = this.db.select().from(agentCapabilityResults).where(and(eq(agentCapabilityResults.id, archiveId), eq(agentCapabilityResults.executionId, executionId))).get();
    const value = asRecord(archive?.value);
    if (!value || value.kind !== 'native-context') throw new NotFoundException('History archive not found');
    const source = JSON.stringify(value.messages);
    return { archiveId, offset, totalChars: source.length, nextOffset: offset + maxChars < source.length ? offset + maxChars : null, content: source.slice(offset, offset + maxChars) };
  }

  async controlSubAgent(request: Request, workspaceSlug: string, agentId: string, executionId: string, runId: string, action: 'pause' | 'resume' | 'cancel') {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.loadExecution(workspace.id, agentId, executionId);
    if (!this.collaboration) throw new BadRequestException('Agent collaboration is unavailable.');
    return this.collaboration.controlInstance(workspace.id, executionId, runId, action);
  }

  async events(request: Request, workspaceSlug: string, agentId: string, executionId: string, afterSequence = 0): Promise<AgentExecutionEvent[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.loadExecution(workspace.id, agentId, executionId);
    const rows = await this.db.select().from(agentExecutionEvents)
      .where(and(eq(agentExecutionEvents.executionId, executionId), gt(agentExecutionEvents.sequence, afterSequence)))
      .orderBy(asc(agentExecutionEvents.sequence));
    return rows.map(toExecutionEvent);
  }

  async recordsEvents(request: Request, workspaceSlug: string, agentId: string, executionId: string): Promise<AgentExecutionEvent[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.loadExecution(workspace.id, agentId, executionId);
    const [latestSnapshot] = await this.db.select({ sequence: agentExecutionEvents.sequence }).from(agentExecutionEvents)
      .where(and(eq(agentExecutionEvents.executionId, executionId), eq(agentExecutionEvents.kind, 'snapshot')))
      .orderBy(desc(agentExecutionEvents.sequence)).limit(1);
    const rows = await this.db.select().from(agentExecutionEvents)
      .where(and(
        eq(agentExecutionEvents.executionId, executionId),
        or(sql`${agentExecutionEvents.kind} <> 'snapshot'`, eq(agentExecutionEvents.sequence, latestSnapshot?.sequence ?? -1)),
      ))
      .orderBy(asc(agentExecutionEvents.sequence));
    return rows.map(toExecutionEvent);
  }

  subscribe(listener: (event: AgentExecutionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  continue(request: Request, workspaceSlug: string, agentId: string, executionId: string, input: ContinueAgentExecutionRequest, accept?: ConversationAcceptance): Promise<AgentExecutionView> {
    // Serialize replacement messages through interruption, persistence and scheduling. The next
    // message may interrupt the newly started turn, but never races its predecessor's cleanup.
    const controller = new AbortController();
    const pending = this.pendingContinuations.get(executionId) ?? new Set<AbortController>();
    pending.add(controller);
    this.pendingContinuations.set(executionId, pending);
    const previous = this.continuationQueues.get(executionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.continueTurn(request, workspaceSlug, agentId, executionId, input, controller.signal, accept));
    this.continuationQueues.set(executionId, next);
    return next.finally(() => {
      pending.delete(controller);
      if (!pending.size) this.pendingContinuations.delete(executionId);
      if (this.continuationQueues.get(executionId) === next) this.continuationQueues.delete(executionId);
    });
  }

  private async continueTurn(request: Request, workspaceSlug: string, agentId: string, executionId: string, input: ContinueAgentExecutionRequest, signal: AbortSignal, accept?: ConversationAcceptance): Promise<AgentExecutionView> {
    signal.throwIfAborted();
    this.requireActiveAgent(agentId);
    assertRuntimeAdmission();
    if (input?.mode !== undefined) return this.queueMessage(request, workspaceSlug, agentId, executionId, input);
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    this.requireTopLevelAgent(workspace.id, agentId);
    let execution = await this.loadExecution(workspace.id, agentId, executionId);
    const content = normalizeUserMessage(input?.message);
    if (agentId === CHAT_AGENT_ID || !execution.capabilitySnapshot?.agent.runtime || execution.capabilitySnapshot.agent.runtime.kind === 'native') await this.requireExecutableAgent(workspace.id, agentId);
    if (execution.status === 'running') {
      await this.cancelTurn(request, workspaceSlug, agentId, executionId, true);
      await this.scheduledExecutions.get(executionId);
      execution = await this.loadExecution(workspace.id, agentId, executionId);
    }
    signal.throwIfAborted();
    if (this.scheduledExecutions.has(executionId)) throw new ConflictException('The previous Agent turn is still settling. Try again when it has stopped.');
    if (agentId !== CHAT_AGENT_ID && this.db.select({ status: agentRuntimeSessions.status }).from(agentRuntimeSessions).where(eq(agentRuntimeSessions.id, executionId)).get()?.status === 'closed') throw new ConflictException('This Agent session is closed. Start a new conversation.');
    if (execution.status === 'running' || execution.status === 'waiting_for_input') throw new ConflictException(execution.status === 'waiting_for_input' ? 'Answer the pending Agent question before sending another message.' : 'This Agent execution is already running.');
    const unresolvedToolCall = (await this.db.select({ id: agentToolCalls.id }).from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.resultAppended, false))).limit(1))[0];
    if (unresolvedToolCall) throw new ConflictException('请先重试本轮对话，处理尚未结束的工具调用；外部效果不会自动重跑。');
    const previousView = await this.toView(execution);
    const priorCalls = agentId !== CHAT_AGENT_ID && execution.capabilitySnapshot?.agent.runtime?.kind !== 'codex' && execution.capabilitySnapshot?.agent.runtime?.kind !== 'claude'
      ? this.db.select().from(agentToolCalls).where(eq(agentToolCalls.executionId, executionId)).all() : [];
    const history = normalizeAgentModelMessages(execution.modelMessages);
    const cleanedHistory = JSON.stringify(history) !== JSON.stringify(execution.modelMessages);
    const historyRef = cleanedHistory ? `acr_${randomUUID()}` : null;
    signal.throwIfAborted();
    let accepted = false;
    this.db.transaction((transaction) => {
      const chatSnapshot = agentId === CHAT_AGENT_ID ? this.captureCapabilities(transaction, workspace.id, agentId)! : undefined;
      const updated = transaction.update(agentExecutions).set(executionUpdates(executionId, {
        capabilitySnapshot: chatSnapshot
          ? chatSnapshot
          : execution.capabilitySnapshot?.agent.runtime && execution.capabilitySnapshot.agent.runtime.kind !== 'native'
            ? execution.capabilitySnapshot : this.captureCapabilities(transaction, workspace.id, agentId),
        executionAuthorization: null,
        status: 'running',
        phase: 'model',
        errorCode: null,
        modelMessages: [...history, ...(historyRef ? [{ role: 'user' as const, content: `Legacy recovery evidence was deduplicated. Complete original history is stored as resultRef ${historyRef}; use read_result only when needed. Do not replay uncertain external effects.` }] : []), { role: 'user', content }],
        displayMessages: appendExecutionMessages(executionId, 'display', [{ id: `msg_${randomUUID()}`, role: 'user', content: agentTaskDisplayText(content), createdAt: new Date().toISOString() }]),
        error: null,
        updatedAt: new Date(),
      })).where(and(eq(agentExecutions.id, executionId), or(eq(agentExecutions.status, 'completed'), eq(agentExecutions.status, 'cancelled'), eq(agentExecutions.status, 'failed')))).run();
      accepted = updated.changes > 0;
      if (accepted) {
        if (historyRef) transaction.insert(agentCapabilityResults).values({ id: historyRef, executionId, value: { kind: 'conversation-history', messages: execution.modelMessages } }).run();
        for (const call of priorCalls.filter((call) => call.status === 'running')) {
          const failure = platformFailure('execution', 'PLATFORM_EXECUTION_INTERRUPTED', 'unknown');
          const platform = isProtectedPlatformSkillId(workspace.id, call.skillId);
          transaction.update(agentToolCalls).set({ status: 'failed', output: platform ? JSON.stringify({ failure }) : call.output || 'Interrupted before a result was recorded. The external outcome is unknown; inspect effects before retrying.', finishedAt: new Date() }).where(and(eq(agentToolCalls.id, call.id), eq(agentToolCalls.status, 'running'))).run();
          if (platform) transaction.insert(auditLogs).values(platformFailureAudit(call, failure)).onConflictDoNothing().run();
        }
        const interruptedChildren = transaction.select().from(auditLogs).where(and(eq(auditLogs.workspaceId, workspace.id), eq(auditLogs.resource, executionId), eq(auditLogs.action, 'agent.invocation'), sql`json_extract(${auditLogs.metadata}, '$.parentRunId') is not null`, sql`json_extract(${auditLogs.metadata}, '$.status') = 'running'`)).all();
        for (const child of interruptedChildren) transaction.update(auditLogs).set({ metadata: { ...child.metadata, status: 'failed', error: 'Interrupted before a result was recorded.', finishedAt: new Date().toISOString() } }).where(eq(auditLogs.id, child.id)).run();
        accept?.(transaction, executionId, previousView);
      }
    });
    if (!accepted) throw new ConflictException('This Agent execution is no longer ready for another message.');
    await this.publishSnapshotForExecution(workspace.id, executionId);
    this.schedule(request, workspaceSlug, executionId);
    return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
  }

  /**
   * Edits the given user message (replacing its text) or regenerates the reply after it
   * (message omitted), discarding everything from that point on and re-running the turn.
   * Native Chat only: other Agents' model/display histories do not correspond 1:1, and a
   * runtime-backed Agent's engine session has no equivalent rewind.
   */
  rewind(request: Request, workspaceSlug: string, agentId: string, executionId: string, input: { messageId: string; message?: string }): Promise<AgentExecutionView> {
    if (agentId !== CHAT_AGENT_ID) return Promise.reject(new BadRequestException('Rewind is available for native Chat conversations only.'));
    const controller = new AbortController();
    const pending = this.pendingContinuations.get(executionId) ?? new Set<AbortController>();
    pending.add(controller);
    this.pendingContinuations.set(executionId, pending);
    const previous = this.continuationQueues.get(executionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.rewindTurn(request, workspaceSlug, agentId, executionId, input, controller.signal));
    this.continuationQueues.set(executionId, next);
    return next.finally(() => {
      pending.delete(controller);
      if (!pending.size) this.pendingContinuations.delete(executionId);
      if (this.continuationQueues.get(executionId) === next) this.continuationQueues.delete(executionId);
    });
  }

  private async rewindTurn(request: Request, workspaceSlug: string, agentId: string, executionId: string, input: { messageId: string; message?: string }, signal: AbortSignal): Promise<AgentExecutionView> {
    signal.throwIfAborted();
    this.requireActiveAgent(agentId);
    assertRuntimeAdmission();
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    this.requireTopLevelAgent(workspace.id, agentId);
    let execution = await this.loadExecution(workspace.id, agentId, executionId);
    if (execution.status === 'running') {
      await this.cancelTurn(request, workspaceSlug, agentId, executionId, true);
      await this.scheduledExecutions.get(executionId);
      execution = await this.loadExecution(workspace.id, agentId, executionId);
    }
    signal.throwIfAborted();
    if (this.scheduledExecutions.has(executionId)) throw new ConflictException('The previous Agent turn is still settling. Try again when it has stopped.');
    if (!['completed', 'failed', 'cancelled'].includes(execution.status)) throw new ConflictException(execution.status === 'waiting_for_input' ? 'Answer the pending question before editing an earlier message.' : 'This conversation is already running.');
    const unresolvedToolCall = (await this.db.select({ id: agentToolCalls.id }).from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.resultAppended, false))).limit(1))[0];
    if (unresolvedToolCall) throw new ConflictException('请先重试本轮对话，处理尚未结束的工具调用；外部效果不会自动重跑。');
    if (this.projectTasks.activeForExecution(executionId).length) throw new ConflictException('This conversation has a project task still in progress; wait for it to settle before editing an earlier message.');

    const displayIndex = execution.displayMessages.findIndex((message) => message.id === input.messageId);
    if (displayIndex < 0) throw new NotFoundException('This message is no longer part of the conversation.');
    const target = execution.displayMessages[displayIndex]!;
    const editing = input.message !== undefined;
    if (editing && target.role !== 'user') throw new BadRequestException('Only a user message can be edited.');
    if (!editing && target.role !== 'assistant') throw new BadRequestException('Only an assistant reply can be regenerated; edit the user message above it instead.');
    // Regenerating finds the user message this reply answers; editing acts on the message itself.
    const userDisplayIndex = editing ? displayIndex : execution.displayMessages.slice(0, displayIndex).map((message) => message.role).lastIndexOf('user');
    if (userDisplayIndex < 0) throw new ConflictException('No user message precedes this reply.');
    const userMessage = execution.displayMessages[userDisplayIndex]!;
    const content = editing ? normalizeUserMessage(input.message) : userMessage.content;

    const history = normalizeAgentModelMessages(execution.modelMessages);
    const cleanedHistory = JSON.stringify(history) !== JSON.stringify(execution.modelMessages);
    // The matching point in model history is the nth user message counting from the start,
    // where n is this user display message's position among display-level user messages.
    // Synthetic user model messages (recovery notes, queued-message replays) do not create
    // their own display message, so they stay attached to the display user message before them
    // and are discarded together with it.
    const userOrdinal = execution.displayMessages.slice(0, userDisplayIndex).filter((message) => message.role === 'user').length;
    let seen = 0;
    let modelCut = -1;
    for (const [index, message] of history.entries()) {
      if (message.role !== 'user') continue;
      if (seen === userOrdinal) { modelCut = index; break; }
      seen += 1;
    }
    if (modelCut < 0) throw new ConflictException('This message could not be matched to the conversation\'s model history; retry after the conversation state refreshes.');
    const retainedModelMessages = history.slice(0, modelCut);
    const retainedDisplayMessages = execution.displayMessages.slice(0, userDisplayIndex);
    const discardedToolCallIds = new Set(history.slice(modelCut).flatMap((message) => message.role === 'assistant' ? message.content.flatMap((part) => part.type === 'tool-call' ? [part.toolCallId] : []) : []));
    const discardedCallIds = discardedToolCallIds.size ? this.db.select({ id: agentToolCalls.id }).from(agentToolCalls)
      .where(and(eq(agentToolCalls.executionId, executionId), inArray(agentToolCalls.toolCallId, [...discardedToolCallIds]))).all() : [];

    const historyRef = cleanedHistory ? `acr_${randomUUID()}` : null;
    const archiveRef = `acr_${randomUUID()}`;
    let accepted = false;
    this.db.transaction((transaction) => {
      const chatSnapshot = this.captureCapabilities(transaction, workspace.id, agentId)!;
      const updated = transaction.update(agentExecutions).set(executionUpdates(executionId, {
        capabilitySnapshot: chatSnapshot,
        executionAuthorization: null,
        status: 'running',
        phase: 'model',
        errorCode: null,
        modelMessages: [...retainedModelMessages, ...(historyRef ? [{ role: 'user' as const, content: `Legacy recovery evidence was deduplicated. Complete original history is stored as resultRef ${historyRef}; use read_result only when needed. Do not replay uncertain external effects.` }] : []), { role: 'user' as const, content }],
        displayMessages: [...retainedDisplayMessages, { id: `msg_${randomUUID()}`, role: 'user', content: agentTaskDisplayText(content), createdAt: new Date().toISOString() }],
        error: null,
        updatedAt: new Date(),
      })).where(and(eq(agentExecutions.id, executionId), or(eq(agentExecutions.status, 'completed'), eq(agentExecutions.status, 'cancelled'), eq(agentExecutions.status, 'failed')))).run();
      accepted = updated.changes > 0;
      if (!accepted) return;
      if (historyRef) transaction.insert(agentCapabilityResults).values({ id: historyRef, executionId, value: { kind: 'conversation-history', messages: execution.modelMessages } }).run();
      // Discarded tool calls remain in the database as inert evidence (under their original
      // archive reference) rather than being deleted: their external effects, if any, already
      // happened and must stay inspectable.
      if (discardedCallIds.length) transaction.insert(agentCapabilityResults).values({ id: archiveRef, executionId, value: { kind: 'conversation-rewind', discardedCallIds: discardedCallIds.map((call) => call.id) } }).run();
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId: workspace.id, action: 'agent_execution.rewound', resource: executionId, metadata: { agentId, executionId, messageId: input.messageId, editing, archiveRef } }).run();
    });
    if (!accepted) throw new ConflictException('This conversation changed before the edit could be applied.');
    await this.publishSnapshotForExecution(workspace.id, executionId);
    this.schedule(request, workspaceSlug, executionId);
    return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
  }

  async queueMessage(request: Request, workspaceSlug: string, agentId: string, executionId: string, input: ContinueAgentExecutionRequest): Promise<AgentExecutionView> {
    assertRuntimeAdmission();
    if (input.mode !== 'steering' && input.mode !== 'follow_up') throw new BadRequestException('Choose steering or follow_up.');
    const message = normalizeUserMessage(input.message);
    if (input.messageId !== undefined && (typeof input.messageId !== 'string' || !input.messageId.trim() || input.messageId.length > 200)) throw new BadRequestException('Invalid messageId.');
    const id = `queued_${input.messageId ?? randomUUID()}`;
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    this.db.transaction((tx) => {
      const execution = tx.select(agentExecutionColumns).from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.agentId, agentId), eq(agentExecutions.workspaceId, workspace.id))).get();
      if (!execution) throw new NotFoundException('Agent execution not found');
      if (agentId !== CHAT_AGENT_ID) throw new BadRequestException('Message queues are available for native Chat only.');
      const duplicate = execution.queuedMessages.find((entry) => entry.id === id);
      if (duplicate) {
        if (duplicate.message !== message || duplicate.mode !== input.mode) throw new ConflictException('This messageId belongs to a different message.');
        return;
      }
      const consumed = execution.displayMessages.find((entry) => entry.id === id);
      if (consumed) {
        if (consumed.content !== agentTaskDisplayText(message)) throw new ConflictException('This messageId belongs to a different message.');
        return;
      }
      if (!['running', 'completed'].includes(execution.status)) throw new ConflictException('Answer the pending question or explicitly resume this conversation before queuing messages.');
      if (execution.status === 'completed' && tx.select({ id: agentToolCalls.id }).from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.resultAppended, false))).get()) throw new ConflictException('Resolve the unfinished tool calls before queuing another message.');
      tx.update(agentExecutions).set({ queuedMessages: [...execution.queuedMessages, { id, message, mode: input.mode!, createdAt: new Date().toISOString() }], updatedAt: new Date() }).where(eq(agentExecutions.id, executionId)).run();
    });
    await this.publishSnapshotForExecution(workspace.id, executionId);
    const execution = await this.loadExecution(workspace.id, agentId, executionId);
    if (execution.status === 'completed') this.schedule(request, workspaceSlug, executionId);
    return this.toView(execution);
  }

  async removeQueuedMessage(request: Request, workspaceSlug: string, agentId: string, executionId: string, messageId: string): Promise<AgentExecutionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    this.db.transaction((tx) => {
      const execution = tx.select(agentExecutionColumns).from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.agentId, agentId), eq(agentExecutions.workspaceId, workspace.id))).get();
      if (!execution) throw new NotFoundException('Agent execution not found');
      if (!execution.queuedMessages.some((entry) => entry.id === messageId)) throw new ConflictException('This queued message has already started or was removed.');
      tx.update(agentExecutions).set({ queuedMessages: execution.queuedMessages.filter((entry) => entry.id !== messageId), updatedAt: new Date() }).where(eq(agentExecutions.id, executionId)).run();
    });
    await this.publishSnapshotForExecution(workspace.id, executionId);
    return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
  }

  private consumeQueuedMessage(workspaceId: string, executionId: string): boolean {
    return this.db.transaction((tx) => {
      const execution = tx.select(agentExecutionColumns).from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.workspaceId, workspaceId))).get();
      if (!execution || execution.agentId !== CHAT_AGENT_ID || !['running', 'completed'].includes(execution.status)) return false;
      if (tx.select({ id: agentToolCalls.id }).from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.resultAppended, false))).get()) return false;
      const next = execution.queuedMessages.find((entry) => entry.mode === 'steering')
        ?? (execution.status === 'completed' ? execution.queuedMessages.find((entry) => entry.mode === 'follow_up') : undefined);
      if (!next) return false;
      tx.update(agentExecutions).set(executionUpdates(executionId, {
        queuedMessages: execution.queuedMessages.filter((entry) => entry.id !== next.id),
        modelMessages: [...execution.modelMessages, { role: 'user', content: next.message }],
        displayMessages: [...execution.displayMessages, { id: next.id, role: 'user', content: agentTaskDisplayText(next.message), createdAt: new Date().toISOString() }],
        status: 'running', phase: 'model', executionAuthorization: null, updatedAt: new Date(),
      })).where(eq(agentExecutions.id, executionId)).run();
      return true;
    });
  }

  async answerProjectTask(request: Request, workspaceSlug: string, taskId: string, input: AnswerAgentQuestionRequest): Promise<ChatProjectTaskView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const task = await this.projectTasks.answer(workspace.id, taskId, input, () => undefined);
    // The answered task resumes in the background; its next settlement reports again.
    this.startProjectTaskBackground(workspace.id, task.executionId, task.id);
    await this.publishSnapshotForExecution(workspace.id, task.executionId);
    return this.projectTasks.view(task.id, workspace.id);
  }

  async cancelProjectTask(request: Request, workspaceSlug: string, taskId: string): Promise<ChatProjectTaskView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    this.projectTasks.view(taskId, workspace.id);
    const task = await this.projectTasks.cancel(taskId);
    await this.publishSnapshotForExecution(workspace.id, task.executionId);
    return this.projectTasks.view(task.id, workspace.id);
  }

  // Submits a mid-run correction without cancelling the task; see ChatProjectTasksService.steer
  // for delivery vs. queue semantics. The owning conversation's snapshot refreshes either way so
  // the task card reflects the queued (or delivered) instruction immediately.
  async steerProjectTask(request: Request, workspaceSlug: string, taskId: string, text: string): Promise<ChatProjectTaskView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const view = this.projectTasks.view(taskId, workspace.id);
    const updated = await this.projectTasks.steer(workspace.id, taskId, text);
    await this.publishSnapshotForExecution(workspace.id, view.executionId);
    return updated;
  }

  async retry(request: Request, workspaceSlug: string, agentId: string, executionId: string): Promise<AgentExecutionView> {
    this.requireActiveAgent(agentId);
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    this.requireTopLevelAgent(workspace.id, agentId);
    const execution = await this.loadExecution(workspace.id, agentId, executionId);
    if (!execution.capabilitySnapshot) await this.requireExecutableAgent(workspace.id, agentId);
    if (execution.status !== 'failed') throw new ConflictException('Only a failed Agent execution can be retried.');
    if (agentId !== CHAT_AGENT_ID && execution.capabilitySnapshot?.agent.runtime && execution.capabilitySnapshot.agent.runtime.kind !== 'native') throw new ConflictException('Engine-backed work cannot be replayed. Send a new message to continue the saved session after inspecting prior effects.');
    const unresolvedCalls = await this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.resultAppended, false)));
    const projectTaskCall = agentId === CHAT_AGENT_ID ? unresolvedCalls.find((call) => call.toolName === 'builtin' && call.mcpToolName === 'project_task') : undefined;
    if (projectTaskCall) {
      this.db.transaction((transaction) => {
        const updated = transaction.update(agentExecutions).set({ status: 'running', phase: 'skill', error: null, errorCode: null, updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'failed'))).run();
        if (updated.changes === 0) throw new ConflictException('This project task is no longer ready to retry.');
        transaction.update(agentToolCalls).set({ status: 'running', finishedAt: null }).where(eq(agentToolCalls.id, projectTaskCall.id)).run();
      });
      void this.executeProjectTaskTool(request, workspaceSlug, workspace.id, executionId, projectTaskCall).catch((error) => this.failBackgroundExecution(workspace.id, executionId, error));
      await this.publishSnapshotForExecution(workspace.id, executionId);
      return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
    }

    const shellCall = agentId === CHAT_AGENT_ID ? unresolvedCalls.find((call) => call.toolName === 'builtin' && call.mcpToolName === 'bash' && call.shell) : undefined;
    if (shellCall) return this.retryShell(request, workspaceSlug, workspace.id, executionId, shellCall);

    let accepted = false;
    const retryResults = unresolvedCalls.map((call) => ({ type: 'tool-result' as const, toolCallId: call.toolCallId, toolName: modelToolName(call), output: toolCallOutput(call.status === 'running' ? { ...call, status: 'failed', output: JSON.stringify({ failure: platformFailure('execution', 'PLATFORM_EXECUTION_INTERRUPTED', 'unknown') }) } : call, workspace.id) }));
    const retryMessages = insertAgentToolResults(execution.modelMessages, retryResults);
    this.db.transaction((transaction) => {
      const updated = transaction.update(agentExecutions).set(executionUpdates(executionId, { status: 'running', phase: 'model', errorCode: null, error: null, pendingQuestion: null, modelMessages: retryMessages, updatedAt: new Date() })).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'failed'))).run();
      accepted = updated.changes > 0;
      if (accepted) {
        for (const call of unresolvedCalls) {
          const failure = platformFailure('execution', 'PLATFORM_EXECUTION_INTERRUPTED', 'unknown');
          transaction.update(agentToolCalls).set({ status: call.status === 'running' ? 'failed' : call.status, output: call.status === 'running' ? JSON.stringify({ failure }) : call.output, resultAppended: true, finishedAt: call.finishedAt ?? new Date() }).where(and(eq(agentToolCalls.id, call.id), eq(agentToolCalls.resultAppended, false))).run();
          if (call.status === 'running' && isProtectedPlatformSkillId(workspace.id, call.skillId)) transaction.insert(auditLogs).values(platformFailureAudit(call, failure)).onConflictDoNothing().run();
        }
      }
    });
    if (!accepted) throw new ConflictException('This Agent execution is no longer ready to retry.');
    await Promise.all(unresolvedCalls.flatMap((call) => call.commandExecutionId ? [this.skillScripts.cancel(call.commandExecutionId).catch(() => undefined)] : []));
    await this.publishSnapshotForExecution(workspace.id, executionId);
    this.schedule(request, workspaceSlug, executionId);
    return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
  }

  async answer(request: Request, workspaceSlug: string, agentId: string, executionId: string, input: AnswerAgentQuestionRequest, accept?: ConversationAcceptance): Promise<AgentExecutionView> {
    this.requireActiveAgent(agentId);
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const execution = await this.loadExecution(workspace.id, agentId, executionId);
    if (execution.status !== 'waiting_for_input' || !execution.pendingQuestion || execution.pendingQuestion.id !== input?.questionId) throw new ConflictException('This Agent execution is not waiting for that question.');
    const answer = normalizeUserMessage(input?.answer);
    if (execution.pendingQuestion.runtimeInteractionId) {
      await this.agentRuntime.answer(workspace.id, executionId, execution.pendingQuestion.runtimeInteractionId, answer, (transaction) => {
        const updated = transaction.update(agentExecutions).set(executionUpdates(executionId, { status: 'running', pendingQuestion: null, displayMessages: appendExecutionMessages(executionId, 'display', [{ id: `msg_${randomUUID()}`, role: 'user', content: agentTaskDisplayText(answer), createdAt: new Date().toISOString() }]), updatedAt: new Date() })).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'waiting_for_input'), sql`json_extract(${agentExecutions.pendingQuestion}, '$.id') = ${input.questionId}`)).run();
        if (!updated.changes) throw new ConflictException('This Agent question has already been answered.');
        accept?.(transaction, executionId);
      });
      await this.publishSnapshotForExecution(workspace.id, executionId);
      return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
    }
    if (execution.pendingQuestion.projectTaskId) {
      const taskId = execution.pendingQuestion.projectTaskId;
      await this.projectTasks.answer(workspace.id, taskId, input, (transaction) => {
        const updated = transaction.update(agentExecutions).set({ status: 'running', phase: 'skill', pendingQuestion: null, updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'waiting_for_input'))).run();
        if (updated.changes === 0) throw new ConflictException('This project task question has already been answered.');
        accept?.(transaction, executionId);
      });
      const [call] = await this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.id, taskId), eq(agentToolCalls.executionId, executionId))).limit(1);
      if (!call) throw new ConflictException('The project task is no longer bound to this turn.');
      void this.executeProjectTaskTool(request, workspaceSlug, workspace.id, executionId, call).catch((error) => this.failBackgroundExecution(workspace.id, executionId, error));
      await this.publishSnapshotForExecution(workspace.id, executionId);
      return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
    }
    if (execution.pendingQuestion.shellCallId) return this.answerShell(request, workspaceSlug, workspace.id, executionId, input, accept);
    if (input.recoveryDecision) throw new BadRequestException('Only an operation recovery question accepts a recovery decision.');

    const pendingCall = (await this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.status, 'running'), eq(agentToolCalls.resultAppended, false))).limit(1))[0];
    if (!pendingCall) throw new ConflictException('The clarification request is no longer active.');
    const now = new Date();
    const approval = execution.pendingQuestion.action === 'confirm_execution' ? execution.executionAuthorization : null;
    if (execution.pendingQuestion.action === 'confirm_execution' && (!approval || approval.questionId !== input.questionId || approval.status !== 'pending')) throw new ConflictException('This proposal is no longer awaiting confirmation.');
    const approved = ['确认执行', '确认', '同意', '同意执行', '执行', '好的', '可以', '可以执行', '继续', 'yes', 'ok', 'confirm', 'approve'].includes(answer.trim().toLowerCase());
    const executionAuthorization = approval ? { ...approval, status: approved ? 'approved' as const : 'declined' as const, approvedAt: approved ? now.toISOString() : null } : execution.executionAuthorization;
    let accepted = false;
    this.db.transaction((transaction) => {
      const updated = transaction.update(agentExecutions).set({ status: 'running', phase: 'model', pendingQuestion: null, executionAuthorization, updatedAt: now }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'waiting_for_input'), sql`json_extract(${agentExecutions.pendingQuestion}, '$.id') = ${input.questionId}`)).run();
      if (updated.changes === 0) return;
      accepted = true;
      accept?.(transaction, executionId);
      transaction.update(agentToolCalls).set({ status: 'completed', output: answer, resultAppended: false, finishedAt: now }).where(and(eq(agentToolCalls.id, pendingCall.id), eq(agentToolCalls.status, 'running'))).run();
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId: workspace.id, action: 'agent_execution.question_answered', resource: executionId, metadata: { executionId, agentId, questionId: input.questionId, ...(approval ? { authorizationId: approval.id, decision: executionAuthorization!.status } : {}) } }).run();
    });
    if (!accepted) throw new ConflictException('This Agent question is no longer active.');
    await this.publishSnapshotForExecution(workspace.id, executionId);
    void this.resumeAfterToolCalls(request, workspaceSlug, workspace.id, agentId, executionId)
      .catch((error) => this.failBackgroundExecution(workspace.id, executionId, error));
    return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
  }

  cancel(request: Request, workspaceSlug: string, agentId: string, executionId: string): Promise<AgentExecutionView> {
    return this.cancelTurn(request, workspaceSlug, agentId, executionId);
  }

  private async cancelTurn(request: Request, workspaceSlug: string, agentId: string, executionId: string, interrupt = false): Promise<AgentExecutionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const execution = await this.loadExecution(workspace.id, agentId, executionId);
    await this.db.update(agentExecutions).set({ queuedMessages: [] }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.workspaceId, workspace.id)));
    // A later explicit stop takes precedence over directions still waiting for native cleanup.
    if (!interrupt) for (const pending of this.pendingContinuations.get(executionId) ?? []) pending.abort(new ConflictException('The pending direction was cancelled by the user.'));
    // Background project tasks outlive their turn, so Cancel covers them even after the turn settled.
    const activeTasks = !interrupt && agentId === CHAT_AGENT_ID ? this.projectTasks.activeForExecution(executionId) : [];
    if (execution.status !== 'running' && execution.status !== 'waiting_for_input') {
      for (const task of activeTasks) await this.projectTasks.cancel(task.id);
      if (activeTasks.length > 0) await this.publishSnapshotForExecution(workspace.id, executionId);
      if (execution.status === 'cancelled') await this.scheduledExecutions.get(executionId);
      return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
    }
    if (agentId === CHAT_AGENT_ID && execution.pendingQuestion?.shellCallId && execution.pendingQuestion.recovery) return this.toView(execution);

    for (const task of activeTasks) await this.projectTasks.cancel(task.id);

    const calls = await this.db.select().from(agentToolCalls).where(eq(agentToolCalls.executionId, executionId));
    const runningCalls = calls.filter((call) => call.status === 'running' && (!interrupt || !call.resultAppended));
    for (const call of runningCalls.filter((item) => item.mcpToolName === 'project_task')) {
      if (!this.projectTasks.list(executionId).some((task) => task.id === call.id)) continue;
      const task = await this.projectTasks.cancel(call.id);
      if (task.status === 'waiting_for_recovery') {
        await this.db.update(agentExecutions).set({ status: 'waiting_for_input', phase: 'recovery', pendingQuestion: task.pendingQuestion, updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), or(eq(agentExecutions.status, 'running'), eq(agentExecutions.status, 'waiting_for_input'))));
        await this.publishSnapshotForExecution(workspace.id, executionId);
        return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
      }
    }

    const toolResults = calls.filter((call) => !call.resultAppended).map((call) => ({
      type: 'tool-result' as const,
      toolCallId: call.toolCallId,
      toolName: modelToolName(call),
      output: { type: 'error-text' as const, value: call.status !== 'running' && call.output ? call.output : call.shell ? 'The Shell command was cancelled by the user. Inspect the linked Command evidence before repeating any effect.' : 'The tool execution was cancelled by the user.' },
    }));

    const cancelledAt = new Date();
    let cancelled = false;

    this.db.transaction((transaction) => {
      const current = transaction.select(agentExecutionColumns).from(agentExecutions).where(eq(agentExecutions.id, executionId)).get()!;
      const knownCalls = new Set(current.modelMessages.flatMap((message) => message.role === 'assistant' ? message.content.flatMap((part) => part.type === 'tool-call' ? [part.toolCallId] : []) : []));
      const knownResults = new Set(current.modelMessages.flatMap((message) => message.role === 'tool' ? message.content.map((part) => part.toolCallId) : []));
      const modelMessages = insertAgentToolResults(current.modelMessages, toolResults.filter((result) => knownCalls.has(result.toolCallId) && !knownResults.has(result.toolCallId)));
      const result = transaction.update(agentExecutions).set(executionUpdates(executionId, { status: 'cancelled', queuedMessages: [], modelMessages, pendingQuestion: null, executionAuthorization: null, error: null, errorCode: null, updatedAt: cancelledAt })).where(and(eq(agentExecutions.id, executionId), or(eq(agentExecutions.status, 'running'), eq(agentExecutions.status, 'waiting_for_input')))).run();
      if (result.changes === 0) return;
      cancelled = true;
      for (const call of calls.filter((item) => !item.resultAppended)) {
        transaction.update(agentToolCalls).set({ resultAppended: true }).where(eq(agentToolCalls.id, call.id)).run();
      }
      for (const call of runningCalls) {
        const failure = isProtectedPlatformSkillId(workspace.id, call.skillId) ? platformFailure('execution', 'PLATFORM_CANCELLED', 'unknown') : null;
        transaction.update(agentToolCalls).set({ status: 'cancelled', output: call.output || (failure ? JSON.stringify({ failure }) : call.shell ? 'Shell execution cancelled.' : 'Tool execution cancelled.'), resultAppended: true, finishedAt: cancelledAt }).where(and(eq(agentToolCalls.id, call.id), eq(agentToolCalls.status, 'running'))).run();
        if (failure) transaction.insert(auditLogs).values(platformFailureAudit(call, failure)).onConflictDoNothing().run();
      }
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId: workspace.id, action: 'agent_execution.cancelled', resource: executionId, metadata: { agentId, commandExecutionIds: runningCalls.flatMap((call) => call.commandExecutionId ? [call.commandExecutionId] : []) } }).run();
    });

    if (cancelled) {
      this.activeNativeBatches.get(executionId)?.abort();
      this.activeModelRequests.get(executionId)?.abort();
      for (const call of runningCalls) this.activeHostCommands.get(call.id)?.abort();
      for (const call of runningCalls) this.activeMcpRequests.get(call.id)?.abort();
      await Promise.all(runningCalls.flatMap((call) => call.commandExecutionId
        ? [this.skillScripts.cancel(call.commandExecutionId).catch(() => undefined)]
        : []));
      // Read the links again after cancelling the turn: a Shell reservation could have
      // committed just before cancellation, but none can commit after it.
      const shellCalls = await this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), inArray(agentToolCalls.id, runningCalls.map((call) => call.id)), sql`${agentToolCalls.shell} IS NOT NULL`));
      for (const call of shellCalls) {
        if (call.commandExecutionId) {
          await this.commands.cancel(call.commandExecutionId);
          const command = await this.commands.waitForCompletion(call.commandExecutionId);
          await this.db.update(agentToolCalls).set({ shell: { ...call.shell!, state: 'settled' }, output: await this.commands.output(command.id), exitCode: command.exitCode, finishedAt: command.finishedAt ? new Date(command.finishedAt) : cancelledAt }).where(and(eq(agentToolCalls.id, call.id), eq(agentToolCalls.status, 'cancelled')));
        } else await this.db.update(agentToolCalls).set({ shell: { ...call.shell!, state: 'settled' } }).where(and(eq(agentToolCalls.id, call.id), eq(agentToolCalls.status, 'cancelled')));
      }
      if (execution.capabilitySnapshot?.agent.runtime && execution.capabilitySnapshot.agent.runtime.kind !== 'native') await this.agentRuntime.waitForStop(executionId);
      await this.scheduledExecutions.get(executionId);
      // Also settle orphaned invocation records left by a previous process, preserving evidence.
      const interrupted = this.db.select().from(auditLogs).where(and(eq(auditLogs.workspaceId, workspace.id), eq(auditLogs.resource, executionId), eq(auditLogs.action, 'agent.invocation'))).all();
      for (const row of interrupted) {
        if (!['running', 'paused', 'waiting_for_input'].includes(String(row.metadata?.status))) continue;
        this.db.update(auditLogs).set({ metadata: { ...row.metadata, status: 'cancelled', currentActivity: null, finishedAt: cancelledAt.toISOString() } }).where(eq(auditLogs.id, row.id)).run();
      }
      await this.publishSnapshotForExecution(workspace.id, executionId);
    }
    return this.toView(await this.loadExecution(workspace.id, agentId, executionId));
  }

  schedule(request: Request, workspaceSlug: string, executionId: string, progressReport?: ChatProgressReport): void {
    if (this.scheduledExecutions.has(executionId)) return;
    const work = this.advance(request, workspaceSlug, executionId, progressReport)
      .then(() => undefined)
      .catch(async (error) => {
        const workspace = await this.workspaces.getWorkspace(request, workspaceSlug).catch(() => null);
        if (workspace) await this.failBackgroundExecution(workspace.id, executionId, error);
      })
      .finally(() => {
        this.scheduledExecutions.delete(executionId);
        try {
          const current = this.db.select({ status: agentExecutions.status, queuedMessages: agentExecutions.queuedMessages }).from(agentExecutions).where(eq(agentExecutions.id, executionId)).get();
          if (current?.status === 'completed' && current.queuedMessages.length
            && !this.db.select({ id: agentToolCalls.id }).from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.resultAppended, false))).get()) this.schedule(request, workspaceSlug, executionId);
        } catch (error) {
          this.logger.error(`Agent execution ${executionId} queue scheduling failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    this.scheduledExecutions.set(executionId, work);
  }

  private async advance(request: Request, workspaceSlug: string, executionId: string, progressReport?: ChatProgressReport): Promise<AgentExecutionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    this.consumeQueuedMessage(workspace.id, executionId);
    const [execution] = await this.db.select(agentExecutionColumns).from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.workspaceId, workspace.id))).limit(1);
    if (!execution) throw new NotFoundException('Agent execution not found');
    if (execution.status !== 'running') return this.toView(execution);
    this.requireActiveAgent(execution.agentId);
    // New user messages start a turn; clarification answers and retries keep its existing budget.
    const turnStart = execution.modelMessages.map((message) => message.role).lastIndexOf('user');
    const turnToolCallIds = execution.modelMessages.slice(turnStart + 1).flatMap((message) => message.role === 'assistant'
      ? message.content.flatMap((part) => part.type === 'tool-call' ? [part.toolCallId] : [])
      : []);
    const priorToolCalls = turnToolCallIds.length === 0 ? [] : await this.db.select({ id: agentToolCalls.id, toolName: agentToolCalls.toolName, mcpToolName: agentToolCalls.mcpToolName, status: agentToolCalls.status }).from(agentToolCalls)
      .where(and(eq(agentToolCalls.executionId, executionId), inArray(agentToolCalls.toolCallId, turnToolCallIds)));
    // Chat has no per-turn tool budget. Other native helpers retain their existing limit
    // and receive an answer-only step when it is exhausted.
    const maxToolCalls = execution.agentId === CHAT_AGENT_ID ? Infinity : MAX_HELPER_TOOL_ROUNDS;
    const toolBudgetExhausted = priorToolCalls.length >= maxToolCalls;
    const { agent, assignedSkills: capturedSkills } = execution.capabilitySnapshot
      ? { agent: execution.capabilitySnapshot.agent, assignedSkills: execution.capabilitySnapshot.skills }
      : await this.requireExecutableAgent(workspace.id, execution.agentId);
    if (agent.id !== CHAT_AGENT_ID && 'collaboration' in agent && agent.collaboration && (!agent.runtime || agent.runtime.kind === 'native' || agent.collaboration.subAgentIds.length || agent.collaboration.capabilities.length || agent.collaboration.privateTools?.length)) return this.advanceCollaboration(workspace.id, execution);
    if (agent.id !== CHAT_AGENT_ID && agent.runtime && agent.runtime.kind !== 'native') return this.advanceRuntime(request, workspaceSlug, workspace.id, execution);
    const assignedSkills = capturedSkills;
    const protectedPlatformSkill = agent.id === CHAT_AGENT_ID ? assignedSkills.find((skill) => isProtectedPlatformSkillId(workspace.id, skill.id)) : undefined;
    const protectedPlatformManifest = protectedPlatformSkill ? platformToolManifest(protectedPlatformSkill.files) : {};
    const hostCommandTool = protectedPlatformSkill ? platformRuntimeTool(protectedPlatformSkill.files, 'run_host_command') : undefined;
    const skillScripts = assignedSkills.flatMap((skill) => {
      const isProtectedPlatformSkill = isProtectedPlatformSkillId(workspace.id, skill.id);
      if (agent.id === CHAT_AGENT_ID && !isProtectedPlatformSkill) return [];
      const typedTools = isProtectedPlatformSkill ? protectedPlatformManifest : {};
      return skill.files.filter((file) => file.path.startsWith('scripts/') && file.content.startsWith('#!')).map((file) => ({ skillId: skill.id, skillName: skill.name, path: file.path, tool: typedTools[file.path] }));
    });
    const mcpRuntimes = agent.id === CHAT_AGENT_ID ? [] : await this.executionMcpRuntimes(request, workspaceSlug, execution);
    const mcpTools = await this.mcpRuntime.discover(mcpRuntimes);
    const catalog = [...HELPER_BUILTIN_TOOLS, HISTORY_ARCHIVE_TOOL, ...CHAT_AGENT_TOOLS, DISCOVER_CHAT_TOOLS, ...(hostCommandTool ? [hostCommandTool] : []), ...skillScripts.flatMap((script) => script.tool ? [script.tool] : [])];
    const discoveries = agent.id === CHAT_AGENT_ID ? this.db.select({ output: agentToolCalls.output }).from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.mcpToolName, 'discover_tools'), eq(agentToolCalls.status, 'completed'))).all() : [];
    const loadedNames = loadedChatToolNames(nativeChatTurnKey(execution), discoveries.map((call) => call.output));
    // Preserve tools already used in an in-flight turn when upgrading from eager exposure.
    for (const call of priorToolCalls) if (call.status === 'completed' && call.mcpToolName) loadedNames.add(call.mcpToolName);
    const visibleNames = new Set(visibleChatTools(catalog, loadedNames).map((tool) => tool.name));
    const availableSkillScripts = agent.id === CHAT_AGENT_ID ? skillScripts.filter((script) => script.tool && visibleNames.has(script.tool.name)) : skillScripts;
    const availableMcpTools = mcpTools;
    const builtinToolDefinitions = agent.id === CHAT_AGENT_ID
      ? [...HELPER_BUILTIN_TOOLS, HISTORY_ARCHIVE_TOOL, ...CHAT_AGENT_TOOLS, DISCOVER_CHAT_TOOLS, ...(hostCommandTool ? [hostCommandTool] : [])].filter((tool) => visibleNames.has(tool.name))
      : [];
    const skillInstructions = assignedSkills.map((skill) => `## ${skill.name}\n${agent.id === CHAT_AGENT_ID ? nativeChatInstructions(skill.instructions) : skill.instructions}`).filter((value) => value.trim()).join('\n\n');
    const chatOrchestrationRule = agent.id === CHAT_AGENT_ID
      ? [CHAT_ORCHESTRATION_RULE, CHAT_ROUTER_CONTROL_RULE, CHAT_DELEGATION_RULE, hostCommandTool ? CHAT_HOST_COMMAND_RULE : ''].join(' ')
      : '';
    const scriptList = availableSkillScripts.filter((script) => !script.tool).map((script) => `- Skill ${script.skillName} (${script.skillId}): ${script.path}`).join('\n');
    const conversationTasks = agent.id === CHAT_AGENT_ID
      ? await this.db.select({ request: chatSubmissions.message, reference: chatSubmissions.reference }).from(chatSubmissions).where(and(eq(chatSubmissions.executionId, executionId), sql`json_extract(${chatSubmissions.reference}, '$.kind') in ('coder', 'workflow', 'upgrade')`)).orderBy(asc(chatSubmissions.createdAt))
      : [];
    const conversationShellCalls = agent.id === CHAT_AGENT_ID
      ? await this.db.select({ id: agentToolCalls.id, shell: agentToolCalls.shell, workingDirectory: agentToolCalls.workingDirectory, commandExecutionId: agentToolCalls.commandExecutionId, status: agentToolCalls.status, exitCode: agentToolCalls.exitCode }).from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), sql`${agentToolCalls.shell} IS NOT NULL`)).orderBy(asc(agentToolCalls.createdAt))
      : [];
    const [deliveryChat] = agent.id === CHAT_AGENT_ID
      ? await this.db.select({ channel: externalChats.channel }).from(externalChats).where(and(eq(externalChats.workspaceId, workspace.id), eq(externalChats.executionId, executionId))).limit(1)
      : [];
    const systemPrompt = [
      agent.id === CHAT_AGENT_ID ? nativeChatInstructions(agent.systemPrompt.trim()) : agent.systemPrompt.trim(),
      agent.id === CHAT_AGENT_ID ? NATIVE_CHAT_TOOL_GUIDANCE : '',
      agent.id === CHAT_AGENT_ID ? `Current conversation delivery channel: ${deliveryChat?.channel ?? 'web'}. This is the bound delivery channel even when a turn is submitted from Web.` : '',
      agent.id === CHAT_AGENT_ID && agentFiles(this.db) ? `Agent package catalog root for this workspace: ${JSON.stringify(agentFiles(this.db)!.workspaceRoot(workspace.id))}. Use run_host_command to inspect AGENT.md ids and write private skills/ and tools/ files here. Private sub-Agents live under their owner subagents/ directory.` : '',
      agent.id === CHAT_AGENT_ID ? 'Batch independent tool calls together; they execute concurrently. Issue dependent calls or writes to the same resource in separate model steps.' : '',
      conversationShellCalls.length ? `Historical Shell evidence (new direct commands use run_host_command; old uncertain effects require explicit recovery):\n${JSON.stringify(conversationShellCalls)}` : '',
      agent.id === CHAT_AGENT_ID && this.projectTasks.list(executionId).length ? `Conversation-owned project tasks, including background tasks settled after their turn (inspect recorded activity and the project's actual state before repeating a request):\n${JSON.stringify(this.projectTasks.list(executionId))}` : '',
      conversationTasks.length ? `Bound conversation tasks (inspect authoritative Run state before answering or repeating a dispatch):\n${JSON.stringify(conversationTasks)}` : '',
      skillInstructions ? `Assigned Skill instructions:\n\n${skillInstructions}` : '',
      availableSkillScripts.length > 0 ? `${agent.id === CHAT_AGENT_ID ? '' : 'Request at most one Skill script tool at a time. '}Every valid request executes immediately on the WorkLite host without user approval.` : '',
      scriptList ? `Assigned executable Skill scripts:\n${scriptList}\nUse skill_script only with an exact listed Skill id and script path.` : '',
      builtinToolDefinitions.length > 0 ? 'Converse naturally. Use ask_user only when a material user choice or missing information blocks the current request, with relevant options when helpful; a plan is not required. When the intent and target are clear, proceed through the assigned platform scripts.' : '',
      hostCommandTool ? 'Use run_host_command directly for everyday installs, system/version/CLI queries, ordinary file management and short local scripts. It runs through a login zsh with closed stdin, bounded output and a timeout, and supports concurrent independent commands. Directly author Agent-owned Skills, Tools and their local scripts as configuration work. Delegate other code changes, repository-wide investigation and build/test validation through run_agent.' : '',
      availableMcpTools.length > 0 ? `Assigned MCP tools:\n${availableMcpTools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')}` : '',
      chatOrchestrationRule,
    ].filter(Boolean).join('\n\n');
    const abortController = new AbortController();
    this.activeModelRequests.set(executionId, abortController);

    try {
      await this.db.update(agentExecutions).set({ phase: 'model', updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running')));
      const readyExecution = await this.loadExecution(workspace.id, execution.agentId, executionId);
      if (readyExecution.status !== 'running') return this.toView(readyExecution);
      const runtime = await this.resources.providerRuntime(request, workspaceSlug, agent.providerId!, agent.model);
      const streamedMessageId = `msg_${randomUUID()}`;
      const streamedMessageCreatedAt = new Date().toISOString();
      const messagePresentation = progressReport ? { progressReport } : {};
      const diagnosticCalls = agent.id === CHAT_AGENT_ID ? await this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), inArray(agentToolCalls.skillId, protectedPlatformSkillIds(workspace.id)), eq(agentToolCalls.scriptPath, 'scripts/inspect-chat-conversation.mjs'), eq(agentToolCalls.status, 'completed'))) : [];
      let modelMessagesBeforeInference = normalizeAgentModelMessages(execution.modelMessages);
      if (JSON.stringify(modelMessagesBeforeInference) !== JSON.stringify(execution.modelMessages)) {
        const resultRef = `acr_${randomUUID()}`;
        modelMessagesBeforeInference = [{ role: 'user', content: `Original history before recovery repair: resultRef ${resultRef}. Read only when needed.` }, ...modelMessagesBeforeInference];
        this.db.transaction((tx) => {
          tx.insert(agentCapabilityResults).values({ id: resultRef, executionId, value: { kind: 'conversation-history', messages: execution.modelMessages } }).run();
          tx.update(agentExecutions).set(executionUpdates(executionId, { modelMessages: modelMessagesBeforeInference, updatedAt: new Date() })).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running'))).run();
        });
      }
      let persistedModelState = encodeMessageState(modelMessagesBeforeInference);
      let inferenceMessages = await this.withUserImages(workspace.id, executionId, runtime.protocol, diagnosticModelMessages(modelMessagesBeforeInference, diagnosticCalls));
      // Chat's own model loop is charged to the conversation it is running; any other
      // Agent is the 'agent' surface, which has no conversation of its own.
      const correlation = agent.id === CHAT_AGENT_ID
        ? { surface: 'chat' as const, conversationId: executionId }
        : { surface: 'agent' as const, agentRunId: executionId, agentExecutionId: executionId };
      let compactionDropped = 0;
      let emittedText = false;
      const prepareContext = async (force = false) => {
        if (agent.id !== CHAT_AGENT_ID) return;
        const archiveId = `acr_${randomUUID()}`;
        const compacted = await compactNativeContext({
          messages: modelMessagesBeforeInference, systemPrompt,
          tools: [...builtinToolDefinitions, ...availableMcpTools, ...availableSkillScripts.map((script) => script.tool ?? { skillId: script.skillId, path: script.path })],
          archiveId, maxTokens: chatContextBudget(runtime.model), observedInputTokens: execution.usage?.lastInputTokens, force, signal: abortController.signal,
          summarize: async (source) => {
            // A reasoning model spends part of this budget on thinking before it writes the
            // summary; 'minimal' effort keeps that share small, and the ceiling itself is raised
            // well past the ~3 000-token summary compactNativeContext expects, so a model that
            // still thinks at length does not starve the summary itself of room to finish.
            const modelParameters = compactionModelParameters(agent.modelParameters, runtime.protocol);
            const stream = createModelGateway().streamText({
              candidates: [{ provider: runtime.provider, model: runtime.model, modelParameters }], correlation,
              systemPrompt: COMPACTION_SYSTEM_PROMPT,
              messages: [{ role: 'user', content: source }], maxOutputTokens: 16_000, abortSignal: abortController.signal,
            });
            const result = await stream.result;
            if (result.finishReason === 'length') throw new Error('Context summary was truncated; original history was retained.');
            return result.text;
          },
        });
        if (!compacted) return;
        abortController.signal.throwIfAborted();
        this.db.transaction((tx) => {
          const current = tx.select(agentExecutionColumns).from(agentExecutions).where(eq(agentExecutions.id, executionId)).get();
          if (!current || current.status !== 'running' || JSON.stringify(current.modelMessages) !== JSON.stringify(modelMessagesBeforeInference)) throw new ConflictException('Conversation changed during context compaction.');
          tx.insert(agentCapabilityResults).values({ id: archiveId, executionId, value: { kind: 'native-context', messages: modelMessagesBeforeInference, summary: compacted.summary, createdAt: new Date().toISOString() } }).run();
          tx.update(agentExecutions).set(executionUpdates(executionId, { modelMessages: compacted.messages as StoredAgentModelMessage[], updatedAt: new Date() })).where(eq(agentExecutions.id, executionId)).run();
        });
        modelMessagesBeforeInference = compacted.messages as StoredAgentModelMessage[];
        persistedModelState = encodeMessageState(modelMessagesBeforeInference);
        compactionDropped += compacted.dropped;
        inferenceMessages = await this.withUserImages(workspace.id, executionId, runtime.protocol, diagnosticModelMessages(modelMessagesBeforeInference, diagnosticCalls));
      };
      const generate = () => createModelGateway().generateAgentStep({ candidates: [{ provider: runtime.provider, model: runtime.model, modelParameters: agent.modelParameters ?? undefined }], systemPrompt, messages: toolBudgetExhausted ? [...inferenceMessages, { role: 'user', content: TOOL_BUDGET_EXHAUSTED_MESSAGE }] : inferenceMessages, skillScripts: availableSkillScripts, builtinTools: builtinToolDefinitions, mcpTools: availableMcpTools, maxToolRounds: Number.isFinite(maxToolCalls) ? maxToolCalls : undefined, parallelToolCalls: agent.id === CHAT_AGENT_ID, toolsDisabled: toolBudgetExhausted, correlation,
        // Keeps an OpenAI-compatible provider's own prompt cache keyed to this conversation,
        // so the stable system/tool prefix above stays warm across turns.
        promptCacheKey: agent.id === CHAT_AGENT_ID ? executionId : undefined,
        onContextCheckpoint: async (checkpoint) => {
          abortController.signal.throwIfAborted();
          const resultRef = `acr_${randomUUID()}`;
          this.db.insert(agentCapabilityResults).values({ id: resultRef, executionId, value: { kind: 'task-checkpoint', ...checkpoint } }).run();
          return `${resultRef} (read original records with GET /agents/${agent.id}/executions/${executionId}/history-archives/${resultRef}?offset=0&maxChars=12000)`;
        },
        onMessages: async (messages) => {
          abortController.signal.throwIfAborted();
          modelMessagesBeforeInference = messages as StoredAgentModelMessage[];
          const patch = patchExecutionMessages(persistedModelState, modelMessagesBeforeInference);
          if (patch.changed) {
            const updated = this.db.update(agentExecutions).set({ modelMessages: patch.value }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running'))).run();
            if (updated.changes) persistedModelState = patch.encoded;
          }
        }, abortSignal: abortController.signal,
        onTextDelta: (delta) => { emittedText = true; return this.persistEvent(executionId, { kind: 'message_delta', messageId: streamedMessageId, delta, ...messagePresentation }); },
        onReasoningDelta: (delta) => this.persistEvent(executionId, { kind: 'reasoning_delta', messageId: streamedMessageId, delta }),
        onToolInputStart: (event) => this.persistEvent(executionId, { kind: 'native_activity', phase: 'tool_input', toolCallId: event.toolCallId, toolName: event.toolName }),
      });
      const result = await this.nativeLoop.modelStep(async () => {
        try { return await generate(); }
        catch (error) {
          if (agent.id !== CHAT_AGENT_ID || emittedText || abortController.signal.aborted || !isContextLimitError(error)) throw error;
          await prepareContext(true);
          return generate(); // Retry only this model request, never tool execution.
        }
      }, {
        prepareRequest: async () => { await prepareContext(); await this.persistEvent(executionId, { kind: 'native_activity', phase: 'model_start' }); },
        afterResponse: async (response) => { await this.persistEvent(executionId, { kind: 'native_activity', phase: 'model_end', status: response.finishReason ?? 'unknown' }); },
        finishStep: async (error) => { if (error) await this.persistEvent(executionId, { kind: 'native_activity', phase: 'model_end', status: abortController.signal.aborted ? 'cancelled' : 'failed' }); },
      });
      const responseText = normalizeAssistantMessage(result.text);
      if (!responseText && result.toolCalls.length === 0) throw new Error('Empty Agent response');
      if (toolBudgetExhausted && result.toolCalls.length > 0) throw new Error('The Agent reached its maximum tool rounds for this turn.');
      const currentExecution = await this.loadExecution(workspace.id, execution.agentId, executionId);
      if (currentExecution.status !== 'running') return this.toView(currentExecution);
      const finalMessages = patchExecutionMessages(persistedModelState, [...modelMessagesBeforeInference, ...result.responseMessages]);
      const stepUsage: ModelUsage = result.usage ?? { inputTokens: null, outputTokens: null, totalTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null };
      const nextUsage = agent.id === CHAT_AGENT_ID ? accumulateExecutionUsage(currentExecution.usage ?? {}, stepUsage, runtime.model) : currentExecution.usage;
      const reasoningText = result.reasoningText?.trim();
      const displayMessages = responseText ? [...execution.displayMessages, { id: streamedMessageId, role: 'assistant' as const, content: responseText, createdAt: streamedMessageCreatedAt, ...messagePresentation, ...(reasoningText ? { reasoning: reasoningText } : {}) }] : execution.displayMessages;
      let status: 'running' | 'waiting_for_input' | 'completed' = result.toolCalls.length > 0 ? 'running' : 'completed';
      let phase: AgentExecutionPhase = result.toolCalls.length > 0 ? 'skill' : 'model';
      let pendingQuestion: AgentPendingQuestion | null = null;
      let plan: AgentPlanStep[] = execution.plan ?? [];
      const executionAuthorization = execution.executionAuthorization;
      const runningCallIds: string[] = [];
      const immediateCallIds: string[] = [];
      // Rejected and over-limit calls are still persisted with a tool result: the model reads the
      // reason in the next step instead of the turn dying with an opaque execution failure.
      const settledCallIds: string[] = [];
      let turnUpdated = false;

      this.db.transaction((transaction) => {
        const updated = transaction.update(agentExecutions).set(executionUpdates(executionId, { status, phase, errorCode: null, modelMessages: finalMessages.value, displayMessages, plan, pendingQuestion, contextDropped: (execution.contextDropped ?? 0) + compactionDropped + result.contextDropped, usage: nextUsage, error: null, updatedAt: new Date() })).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running'))).run();
        if (updated.changes === 0) return;
        turnUpdated = true;
        for (const [index, requestedCall] of result.toolCalls.entries()) {
          const callId = `acall_${randomUUID()}`;
          const workingDirectory = process.cwd();
          const skill = requestedCall.toolName === 'skill_script' ? assignedSkills.find((item) => item.id === requestedCall.skillId && (agent.id !== CHAT_AGENT_ID || isProtectedPlatformSkillId(workspace.id, item.id))) : undefined;
          const script = skill?.files.find((file) => file.path === requestedCall.scriptPath && file.path.startsWith('scripts/') && file.content.startsWith('#!') && availableSkillScripts.some((available) => available.skillId === skill.id && available.path === file.path));
          const mcpTool = mcpTools.find((tool) => tool.name === requestedCall.toolName);
          // A rejected call is recorded as a failed tool call with a credential-safe reason. The
          // model receives that reason as its tool result and can correct the request next step,
          // so one malformed or over-limit call never fails the whole turn.
          const hiddenTool = agent.id === CHAT_AGENT_ID && requestedCall.toolName === 'skill_script' && skill && !script
            ? 'This platform tool is not loaded. Call discover_tools with its exact toolNames, then retry in the next model step.' : null;
          let rejection = requestedCall.rejection ?? hiddenTool ?? (result.finishReason === 'length' ? 'This tool was not executed because the model output was truncated. Reissue the call with complete arguments.' : null) ?? (priorToolCalls.length + index >= maxToolCalls ? TOOL_BUDGET_EXHAUSTED_MESSAGE : toolCallRejection({
            index,
            total: result.toolCalls.length,
            toolName: requestedCall.toolName,
            chatOnly: agent.id === CHAT_AGENT_ID,
            hasBuiltinTool: builtinToolDefinitions.some((tool) => tool.name === requestedCall.toolName),
            hasSkill: Boolean(skill),
            hasScript: Boolean(script),
            hasMcpTool: Boolean(mcpTool),
            clarificationPass: false,
            projectTaskWithOtherTools: requestedCall.toolName === 'project_task' && result.toolCalls.some((call) => call !== requestedCall && call.toolName !== 'update_plan'),
            pendingQuestion: pendingQuestion !== null,
          }));
          let failure: PlatformFailure | null = rejection ? platformFailure('admission', priorToolCalls.length + index >= maxToolCalls ? 'TOOL_BUDGET_EXHAUSTED' : 'TOOL_NOT_ADMITTED', 'not_started', { evidence: { reason: rejection } }) : null;
          if (requestedCall.normalizationFailure) {
            failure = platformFailure('input', requestedCall.normalizationFailure, 'not_started');
            rejection = JSON.stringify(failure);
          }
          if (!rejection && skill && script && isProtectedPlatformSkillId(workspace.id, skill.id)) {
            const definition = platformToolManifest(skill.files)[script.path];
            let input: unknown = requestedCall.input;
            if (!requestedCall.modelToolName) {
              try { input = JSON.parse(requestedCall.arguments?.[0] ?? '{}'); } catch { input = undefined; }
            }
            const fields = definition ? platformInputIssues(input, definition.inputSchema) : [{ path: '$', rule: 'declaredTool' }];
            if ((requestedCall.arguments?.length ?? 0) > 1) fields.push({ path: '$', rule: 'singleArgument' });
            if (fields.length) {
              failure = platformFailure('input', 'PLATFORM_INPUT_INVALID', 'not_started', { fields });
              rejection = JSON.stringify(failure);
            }
            if (!rejection) {
              const userMessageAt = Date.parse(execution.displayMessages.filter((message) => message.role === 'user').at(-1)?.createdAt ?? '') || 0;
              const fingerprint = platformArgumentsHash(requestedCall.arguments ?? []);
              const prior = transaction.select().from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.skillId, skill.id), eq(agentToolCalls.scriptPath, script.path), inArray(agentToolCalls.status, ['failed', 'cancelled']))).all().find((call) => {
                if (call.createdAt.getTime() < userMessageAt || platformArgumentsHash(call.arguments) !== fingerprint) return false;
                try { const priorFailure = JSON.parse(call.output)?.failure; return priorFailure?.effect === 'applied' || priorFailure?.effect === 'unknown'; } catch { return false; }
              });
              if (prior) {
                failure = platformFailure('admission', 'PLATFORM_REPLAY_BLOCKED', 'unknown', { evidence: { priorCallId: prior.id, commandExecutionId: prior.commandExecutionId } });
                rejection = JSON.stringify(failure);
              }
            }
          }
          if (rejection && failure) rejection = JSON.stringify(failure);
          if (!rejection && requestedCall.toolName === 'update_plan') {
            try { plan = parsePlan(requestedCall.input); } catch (error) { rejection = error instanceof BadRequestException ? error.message : 'The plan update could not be applied.'; }
          } else if (!rejection && requestedCall.toolName === 'ask_user') {
            try { pendingQuestion = createPendingQuestion(requestedCall.input); status = 'waiting_for_input'; phase = 'model'; } catch (error) { rejection = error instanceof BadRequestException ? error.message : 'The conversation question could not be created.'; }
          }
          if (rejection && !failure) { failure = platformFailure('input', 'TOOL_INPUT_INVALID', 'not_started'); rejection = JSON.stringify(failure); }
          if (rejection) settledCallIds.push(callId);
          else if (requestedCall.toolName === 'update_plan') immediateCallIds.push(callId);
          else if (requestedCall.toolName !== 'ask_user') runningCallIds.push(callId);
          transaction.insert(agentToolCalls).values({ id: callId, executionId, workspaceId: workspace.id, agentId: execution.agentId, toolCallId: requestedCall.toolCallId, shell: null, toolName: requestedCall.toolName === 'skill_script' ? 'skill_script' : requestedCall.toolName.startsWith('mcp_') ? 'mcp' : 'builtin', workingDirectory, skillId: skill?.id ?? null, skillName: skill?.name ?? null, scriptPath: script?.path ?? null, mcpServerId: mcpTool?.serverId ?? null, mcpToolName: requestedCall.toolName.startsWith('mcp_') ? mcpTool?.remoteName ?? null : requestedCall.modelToolName ?? requestedCall.toolName, input: requestedCall.input, arguments: requestedCall.arguments ?? [], packageFiles: skill?.files ?? [], status: rejection ? 'failed' : requestedCall.toolName === 'update_plan' ? 'completed' : 'running', output: rejection ?? (requestedCall.toolName === 'update_plan' ? formatPlan(plan) : ''), finishedAt: rejection ? new Date() : null }).run();
          transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId: workspace.id, action: rejection ? `${requestedCall.toolName}.rejected` : requestedCall.toolName === 'skill_script' ? 'skill_script.requested' : requestedCall.toolName === 'ask_user' ? 'agent_execution.question_requested' : `${requestedCall.toolName}.requested`, resource: callId, metadata: { agentId: execution.agentId, executionId, toolName: requestedCall.toolName, skillId: skill?.id ?? null, scriptPath: script?.path ?? null, mcpServerId: mcpTool?.serverId ?? null, mcpToolName: mcpTool?.remoteName ?? null, ...(rejection ? { rejection } : {}) } }).run();
          if (failure) transaction.insert(auditLogs).values({ id: `failure_${callId}`, workspaceId: workspace.id, action: 'platform.tool_failure', resource: callId, metadata: { executionId, toolCallId: requestedCall.toolCallId, scriptPath: script?.path ?? null, contractHash: skill ? platformContractHash(skill.files) : null, failure } }).run();
        }
        transaction.update(agentExecutions).set({ status, phase, plan, pendingQuestion, executionAuthorization }).where(eq(agentExecutions.id, executionId)).run();
        if (status === 'completed') {
          transaction.update(agentSubSessions).set({ unread: true, updatedAt: new Date() }).where(eq(agentSubSessions.executionId, executionId)).run();
          transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId: workspace.id, action: 'agent_execution.completed', resource: executionId, metadata: { agentId: execution.agentId, executionId, phase: 'model', errorCode: null } }).run();
        }
      });
      if (turnUpdated) {
        for (const callId of [...immediateCallIds, ...runningCallIds, ...settledCallIds]) {
          const [call] = await this.db.select().from(agentToolCalls).where(eq(agentToolCalls.id, callId)).limit(1);
          if (call) await this.persistEvent(executionId, { kind: 'tool_call', call: toToolCallView(call) });
        }
        await this.publishSnapshotForExecution(workspace.id, executionId);
      }
      if (turnUpdated && (immediateCallIds.length > 0 || settledCallIds.length > 0)) {
        await this.resumeAfterToolCalls(request, workspaceSlug, workspace.id, execution.agentId, executionId);
      }
      if (turnUpdated && runningCallIds.length > 0) {
        const controller = new AbortController();
        this.activeNativeBatches.set(executionId, controller);
        const jobs = runningCallIds.map((id) => {
          const call = this.db.select().from(agentToolCalls).where(eq(agentToolCalls.id, id)).get()!;
          const definition = call.scriptPath ? protectedPlatformManifest[call.scriptPath] : builtinToolDefinitions.find((tool) => tool.name === call.mcpToolName);
          return { id, policy: execution.agentId === CHAT_AGENT_ID
            ? nativeToolPolicy(workspace.id, call.mcpToolName ?? call.toolName, call.input, definition)
            : { mode: 'sequential' as const },
          execute: async (_signal: AbortSignal, progress: (text: string) => Promise<void>) => {
            this.nativeToolProgress.set(id, progress);
            try { await this.executeToolCall(request, workspaceSlug, workspace.id, execution.agentId, executionId, id); }
            finally { this.nativeToolProgress.delete(id); }
          } };
        });
        void this.nativeLoop.toolBatch(jobs, controller.signal, {
          beforeTool: async (job) => {
            const current = await this.loadExecution(workspace.id, execution.agentId, executionId);
            if (current.status !== 'running') { controller.abort(); controller.signal.throwIfAborted(); }
            await this.persistEvent(executionId, { kind: 'native_activity', phase: 'tool_start', toolCallId: job.id });
          },
          onProgress: (job, text) => this.persistEvent(executionId, { kind: 'native_activity', phase: 'tool_progress', toolCallId: job.id, text }),
          afterTool: async (job, error) => {
            const call = this.db.select({ status: agentToolCalls.status }).from(agentToolCalls).where(eq(agentToolCalls.id, job.id)).get();
            await this.persistEvent(executionId, { kind: 'native_activity', phase: 'tool_end', toolCallId: job.id, status: controller.signal.aborted ? 'cancelled' : error ? 'failed' : call?.status });
          },
          finishBatch: async () => {
            if (this.activeNativeBatches.get(executionId) === controller) this.activeNativeBatches.delete(executionId);
            await this.resumeAfterToolCalls(request, workspaceSlug, workspace.id, execution.agentId, executionId);
          },
        }).catch(async (error) => {
          if (!controller.signal.aborted) await this.markExecutionFailed(workspace.id, executionId, executionFailure(error));
        }).finally(() => {
          if (this.activeNativeBatches.get(executionId) === controller) this.activeNativeBatches.delete(executionId);
        });
      }
    } catch (error) {
      const failure = executionFailure(error);
      if (progressReport && error instanceof ServiceUnavailableException && error.message === 'Portkey Gateway is unavailable.') {
        this.logger.warn(`Agent execution ${executionId}: Gateway unavailable; using the recorded progress report.`);
        // A progress notification can be rendered from the authoritative report without a model.
        // Keep the conversation usable when the Gateway is temporarily unavailable.
        const content = progressReport.items.map((item) => `${item.title}：${item.status}`).join('\n');
        const message = { id: `msg_${randomUUID()}`, role: 'assistant' as const, content, createdAt: new Date().toISOString(), progressReport };
        const updated = await this.db.update(agentExecutions).set(executionUpdates(executionId, { status: 'completed', phase: 'model', errorCode: null, error: null, displayMessages: appendExecutionMessages(executionId, 'display', [message]), modelMessages: appendExecutionMessages(executionId, 'model', [{ role: 'assistant' as const, content: [{ type: 'text' as const, text: content }] }]), updatedAt: new Date() })).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running'))).returning({ id: agentExecutions.id });
        if (updated.length) {
          await this.persistEvent(executionId, { kind: 'message_delta', messageId: message.id, delta: content, progressReport });
          await this.publishSnapshotForExecution(workspace.id, executionId);
        }
      } else {
        this.logger.warn(`Agent execution ${executionId} failed: phase=${failure.phase} code=${failure.code} source=${executionFailureSource(error)}: ${failure.message}`);
        await this.markExecutionFailed(workspace.id, executionId, failure);
      }
    } finally {
      if (this.activeModelRequests.get(executionId) === abortController) this.activeModelRequests.delete(executionId);
    }
    const settled = await this.loadExecution(workspace.id, execution.agentId, executionId);
    if (settled.status === 'completed' && settled.queuedMessages.length) return this.advance(request, workspaceSlug, executionId);
    return this.toView(await this.loadExecution(workspace.id, execution.agentId, executionId));
  }

  /**
   * Turns the user's own attachment images into real image content for this one request, so the
   * conversation model reads the picture the reader pasted instead of a URL it cannot open. The
   * stored history keeps its Markdown references, so nothing here changes what the conversation
   * or any channel shows.
   */
  private async withUserImages(workspaceId: string, executionId: string, protocol: ModelProviderProtocol, messages: GatewayAgentMessage[]): Promise<GatewayAgentMessage[]> {
    const result = await inlineUserAttachmentImages(messages, {
      protocol,
      store: {
        describe: (id) => this.attachments.describe(workspaceId, id),
        load: (id) => this.attachments.load(workspaceId, id),
      },
    });
    if (result.skipped.length > 0) {
      // Named per reason so an image the model never saw is explainable without reproducing the turn.
      const reasons = result.skipped.map((skip) => `${skip.id}:${skip.reason}`).join(', ');
      this.logger.warn(`Chat conversation ${executionId} sent ${result.inlined} user image(s) to ${protocol} and left ${result.skipped.length} as text (${reasons}).`);
    } else if (result.inlined > 0) {
      this.logger.debug(`Chat conversation ${executionId} sent ${result.inlined} user image(s) to ${protocol}.`);
    }
    return result.messages;
  }

  private async executeToolCall(request: Request, workspaceSlug: string, workspaceId: string, agentId: string, executionId: string, callId: string): Promise<void> {
    const [call] = await this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.id, callId), eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.agentId, agentId), eq(agentToolCalls.workspaceId, workspaceId))).limit(1);
    if (!call) throw new NotFoundException('Agent tool request not found');
    if (call.status !== 'running') return;

    if (agentId === CHAT_AGENT_ID && call.toolName === 'builtin' && call.mcpToolName === 'project_task') {
      await this.executeProjectTaskTool(request, workspaceSlug, workspaceId, executionId, call);
      return;
    }

    if (agentId === CHAT_AGENT_ID && call.toolName === 'builtin' && (call.mcpToolName === 'answer_project_task' || call.mcpToolName === 'steer_project_task' || call.mcpToolName === 'cancel_project_task')) {
      await this.executeProjectTaskControlTool(request, workspaceSlug, workspaceId, executionId, call);
      return;
    }

    if (agentId === CHAT_AGENT_ID && call.toolName === 'builtin' && call.mcpToolName === 'bash') {
      await this.executeShell(request, workspaceSlug, workspaceId, executionId, call);
      return;
    }

    if (agentId === CHAT_AGENT_ID && call.toolName === 'builtin' && call.mcpToolName === 'run_host_command') {
      await this.executeHostCommand(request, workspaceSlug, workspaceId, executionId, call);
      return;
    }

    let result: AgentScriptExecutionResult;
    let commandExecutionId: string | null = null;
    let failure: PlatformFailure | null = null;
    let phase: PlatformFailure['stage'] = 'start';
    try {
      if (call.toolName === 'builtin' && agentId === CHAT_AGENT_ID && call.mcpToolName === 'discover_tools') {
        const execution = await this.loadExecution(workspaceId, agentId, executionId);
        if (execution.status !== 'running') return;
        const capturedSkills = execution.capabilitySnapshot?.skills ?? (await this.requireExecutableAgent(workspaceId, agentId)).assignedSkills;
        const platformSkill = capturedSkills.find((skill) => isProtectedPlatformSkillId(workspaceId, skill.id));
        const definitions = platformSkill ? Object.entries(platformToolManifest(platformSkill.files)).filter(([path, tool]) => path.startsWith('scripts/') ? platformSkill.files.some((file) => file.path === path && file.content.startsWith('#!')) : tool.name === 'run_host_command').map(([, tool]) => tool) : [];
        const catalog = [...HELPER_BUILTIN_TOOLS, HISTORY_ARCHIVE_TOOL, ...CHAT_AGENT_TOOLS, DISCOVER_CHAT_TOOLS, ...definitions];
        let discovered: ReturnType<typeof discoverChatTools>;
        try { discovered = discoverChatTools(catalog, call.input, nativeChatTurnKey(execution)); }
        catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Invalid tool discovery request.'); }
        result = { status: 'completed', output: JSON.stringify(discovered), result: null, exitCode: null, commandExecutionId: null };
      } else if (call.toolName === 'builtin' && agentId === CHAT_AGENT_ID && call.mcpToolName === 'read_history_archive') {
        const input = asRecord(call.input);
        result = { status: 'completed', output: JSON.stringify(this.readNativeHistoryArchive(workspaceId, agentId, executionId, String(input?.archiveId ?? ''), Number(input?.offset ?? 0), Number(input?.maxChars ?? 12000))), result: null, exitCode: null, commandExecutionId: null };
      } else if (call.toolName === 'builtin' && agentId === CHAT_AGENT_ID && ['inspect_agents', 'run_agent', 'control_agent_instance'].includes(call.mcpToolName ?? '')) {
        const value = call.mcpToolName === 'inspect_agents'
          ? JSON.stringify(this.collaboration!.list(workspaceId))
          : call.mcpToolName === 'control_agent_instance'
            ? await this.controlBackgroundInstance(request, workspaceSlug, call.input)
            : await this.dispatchBackgroundAgent(request, workspaceSlug, workspaceId, executionId, call);
        result = { status: 'completed', output: value, result: null, exitCode: null, commandExecutionId: null };
      } else if (call.toolName === 'builtin') {
        if (!call.mcpToolName) throw new Error('Built-in tool is no longer available.');
        if (agentId === CHAT_AGENT_ID) {
          throw new BadRequestException('Direct host tools are unavailable to Chat. Delegate this task to a project executor.');
        } else {
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
        }
      } else if (call.toolName === 'mcp') {
        if (agentId === CHAT_AGENT_ID) throw new BadRequestException('Direct MCP calls are unavailable to Chat.');
        const runtimes = await this.executionMcpRuntimes(request, workspaceSlug, await this.loadExecution(workspaceId, agentId, executionId));
        const runtime = runtimes.find((item) => item.id === call.mcpServerId);
        if (!runtime || !call.mcpToolName) throw new Error('MCP tool is no longer available.');
        const abortController = new AbortController();
        this.activeMcpRequests.set(callId, abortController);
        const output = await this.mcpRuntime.call(runtime, call.mcpToolName, call.input, abortController.signal);
        if (this.activeMcpRequests.get(callId) === abortController) this.activeMcpRequests.delete(callId);
        result = { status: 'completed', output, result: null, exitCode: null, commandExecutionId: null };
      } else {
        if (agentId === CHAT_AGENT_ID && !isProtectedPlatformSkillId(workspaceId, call.skillId)) throw new BadRequestException('Chat may only execute protected platform scripts.');
        const turn = await this.loadExecution(workspaceId, agentId, executionId);
        if (turn.capabilitySnapshot) {
          if (!turn.capabilitySnapshot.skills.some((skill) => skill.id === call.skillId)) throw new ConflictException('This Skill is not in the conversation turn snapshot.');
        } else await this.requireSkillAssignment(workspaceId, agentId, call.skillId);
        const isProtectedPlatformCall = agentId === CHAT_AGENT_ID && isProtectedPlatformSkillId(workspaceId, call.skillId);
        const started = await this.skillScripts.start(call.packageFiles, call.scriptPath ?? '', call.arguments, isProtectedPlatformCall ? { chatContext: { executionId, submissionId: call.id, userMessageId: turn.displayMessages.filter((message) => message.role === 'user').at(-1)?.id ?? '' } } : undefined);
        commandExecutionId = started.id;
        phase = 'execution';
        const [linked] = await this.db.update(agentToolCalls).set({ commandExecutionId: started.id }).where(and(eq(agentToolCalls.id, callId), eq(agentToolCalls.status, 'running'))).returning({ id: agentToolCalls.id });
        const execution = await this.loadExecution(workspaceId, agentId, executionId);
        if (!linked || execution.status !== 'running') {
          await this.skillScripts.cancel(started.id).catch(() => undefined);
          return;
        }
        const completed = await this.skillScripts.wait(started.id);
        const imageOutput = completed.execution.status === 'succeeded' && isProtectedPlatformSkillId(workspaceId, call.skillId) && call.scriptPath === 'scripts/upload-local-images.mjs'
          ? localImageToolOutput('stdout' in completed && typeof completed.stdout === 'string' ? completed.stdout : completed.output)
          : null;
        const parsedResult = completed.execution.status === 'succeeded' && isProtectedPlatformSkillId(workspaceId, call.skillId)
          ? call.scriptPath === 'scripts/upload-local-images.mjs'
            ? imageOutput === null ? null : { type: 'snapshot' as const }
            : parseWorkliteScriptResult(completed.stdout)
          : null;
        const succeeded = completed.execution.status === 'succeeded' && (!isProtectedPlatformSkillId(workspaceId, call.skillId) || parsedResult !== null);
        if (!succeeded && isProtectedPlatformSkillId(workspaceId, call.skillId)) {
          failure = completed.execution.status === 'succeeded'
            ? scriptFailure(completed.stdout, true) ?? platformFailure('response', 'PLATFORM_RESULT_CONTRACT_INVALID', 'unknown', { evidence: { processSucceeded: true, exitCode: completed.execution.exitCode } })
            : scriptFailure(completed.stdout) ?? platformFailure('execution', completed.execution.status === 'cancelled' ? 'PLATFORM_CANCELLED' : 'PLATFORM_PROCESS_FAILED', 'unknown', { evidence: { exitCode: completed.execution.exitCode } });
        }
        result = {
          status: completed.execution.status === 'cancelled' ? 'cancelled' : succeeded ? 'completed' : 'failed',
          output: imageOutput ?? completed.output,
          result: parsedResult,
          exitCode: completed.execution.exitCode,
          commandExecutionId: completed.execution.id,
        };
      }
    } catch (error) {
      this.activeMcpRequests.delete(callId);
      const systemCode = asRecord(error)?.code;
      failure = platformFailure(commandExecutionId ? 'execution' : phase, commandExecutionId ? 'PLATFORM_EXECUTION_INTERRUPTED' : 'PLATFORM_START_FAILED', !commandExecutionId && (error instanceof BadRequestException || error instanceof ConflictException) ? 'not_started' : 'unknown', { evidence: { exceptionType: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(error.name) ? error.name : 'Unknown', systemCode: typeof systemCode === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(systemCode) ? systemCode : null, ...(error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException ? { message: error.message } : {}) } });
      result = { status: 'failed', output: error instanceof BadRequestException || error instanceof ConflictException || error instanceof ServiceUnavailableException ? error.message : 'Host execution could not be started.', result: null, exitCode: null, commandExecutionId };
    }
    if (failure) result.output = JSON.stringify({ failure, commandExecutionId: result.commandExecutionId });
    const finishedAt = new Date();
    let finalized = false;
    this.db.transaction((transaction) => {
      const updated = transaction.update(agentToolCalls).set({ ...result, finishedAt }).where(and(eq(agentToolCalls.id, callId), eq(agentToolCalls.status, 'running'))).run();
      if (updated.changes === 0) return;
      finalized = true;
      if (failure) transaction.insert(auditLogs).values({ id: `failure_${callId}`, workspaceId, action: 'platform.tool_failure', resource: callId, metadata: { executionId, toolCallId: call.toolCallId, skillId: call.skillId, scriptPath: call.scriptPath, contractHash: platformContractHash(call.packageFiles), commandExecutionId: result.commandExecutionId, failure } }).run();
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId, action: `${call.toolName}.${result.status}`, resource: callId, metadata: { ...toolAuditMetadata(call), commandExecutionId: result.commandExecutionId, exitCode: result.exitCode } }).run();
    });
    if (finalized) {
      const [updatedCall] = await this.db.select().from(agentToolCalls).where(eq(agentToolCalls.id, callId)).limit(1);
      if (updatedCall) await this.persistEvent(executionId, { kind: 'tool_call', call: toToolCallView(updatedCall) });
      await this.publishSnapshotForExecution(workspaceId, executionId);
    }
    if (finalized && result.status !== 'cancelled') await this.resumeAfterToolCalls(request, workspaceSlug, workspaceId, agentId, executionId);
  }

  private async controlBackgroundInstance(request: Request, workspaceSlug: string, value: unknown): Promise<string> {
    const input = asRecord(value);
    if (!input || !['agentId', 'executionId', 'runId'].every((key) => typeof input[key] === 'string' && (input[key] as string).trim()) || (input.action !== 'pause' && input.action !== 'resume' && input.action !== 'cancel')) throw new BadRequestException('An owning Agent, execution, exact sub-Agent runId and pause/resume/cancel action are required.');
    return JSON.stringify(await this.controlSubAgent(request, workspaceSlug, input.agentId as string, input.executionId as string, input.runId as string, input.action));
  }

  private async dispatchBackgroundAgent(request: Request, workspaceSlug: string, workspaceId: string, conversationId: string, call: typeof agentToolCalls.$inferSelect): Promise<string> {
    const input = asRecord(call.input);
    if (input?.mode !== 'new' && input?.mode !== 'continue') throw new BadRequestException('Choose mode=new for independent work or mode=continue for the same task. Read saved records for status/explanation; use cancellation controls for stop requests.');
    if (input.mode === 'continue' && (typeof input.continuationReason !== 'string' || !input.continuationReason.trim())) throw new BadRequestException('continuationReason must explain which existing task is being continued and what changed.');
    if (input.mode === 'new' && input.executionId !== undefined) throw new BadRequestException('New tasks cannot carry executionId. Pass only necessary background or result references.');
    const agentId = typeof input?.agentId === 'string' ? input.agentId.trim() : '';
    // Acceptance can commit before the tool result is saved. Recover that receipt on a
    // retry instead of launching again or reopening an already delivered notice.
    const accepted = this.db.select().from(auditLogs).where(and(eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.action, 'chat_agent.dispatched'), sql`json_extract(${auditLogs.metadata}, '$.conversationId') = ${conversationId}`, sql`json_extract(${auditLogs.metadata}, '$.toolCallId') = ${call.id}`)).get();
    if (accepted) {
      const metadata = asRecord(accepted.metadata)!;
      return JSON.stringify({ status: 'running', executionId: accepted.resource, agentId: metadata.agentId, agentName: metadata.agentName, runId: metadata.invocationId, background: true, ...(input.mode === 'continue' ? { continued: true } : {}), message: 'Agent 派发已受理，结果会自动汇报。' });
    }
    const agent = this.collaboration!.list(workspaceId).find((item) => item.id === agentId);
    if (!agent) throw new BadRequestException('Select an available top-level Agent.');
    const selected = this.db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId))).get()!;
    const conversation = await this.loadExecution(workspaceId, CHAT_AGENT_ID, conversationId);
    const lastUser = [...conversation.displayMessages].reverse().find((message) => message.role === 'user')?.content ?? '';
    const mention = /\[@[^\]\n]+\]\(\/agents\/([^?/)]+)\?runId=([A-Za-z0-9_-]+)(?:&executionId=[^\s)]+)?\)/.exec(lastUser);
    if (input?.executionId !== undefined && (typeof input.executionId !== 'string' || !input.executionId.trim())) throw new BadRequestException('A non-empty executionId is required to continue an instance.');
    if (input.mode === 'continue' && mention && lastUser.slice(mention.index, lastUser.indexOf(')', mention.index)).includes('&executionId=') && decodeURIComponent(mention[1]!) !== agentId) throw new BadRequestException('Continue the explicitly selected Agent instance.');
    const mentionedExecutionId = input.mode === 'continue' && mention && decodeURIComponent(mention[1]!) === agentId
      ? /[?&]executionId=([^&)]+)/.exec(lastUser.slice(mention.index, lastUser.indexOf(')', mention.index)))?.[1] : undefined;
    const targetExecutionId = mentionedExecutionId ? decodeURIComponent(mentionedExecutionId) : typeof input?.executionId === 'string' ? input.executionId.trim() : '';
    if (mentionedExecutionId && input?.executionId && input.executionId !== targetExecutionId) throw new BadRequestException('The selected Agent instance does not match executionId.');
    if (input.mode === 'continue' && !targetExecutionId) throw new BadRequestException('Select the exact executionId of the same task; do not guess among previous tasks.');
    if (targetExecutionId) {
      const target = await this.loadExecution(workspaceId, agentId, targetExecutionId);
      if (target.status === 'cancelled' && input.resumeCancelled !== true) throw new BadRequestException('This task was cancelled. Set resumeCancelled=true only when the user explicitly requests resuming it.');
      const binding = this.db.select().from(auditLogs).where(and(eq(auditLogs.action, 'chat_agent.dispatched'), eq(auditLogs.resource, targetExecutionId), eq(auditLogs.workspaceId, workspaceId))).get();
      const root = this.db.select().from(auditLogs).where(and(eq(auditLogs.action, 'agent.invocation'), eq(auditLogs.resource, targetExecutionId), eq(auditLogs.workspaceId, workspaceId), sql`json_extract(${auditLogs.metadata}, '$.parentRunId') is null`, sql`json_extract(${auditLogs.metadata}, '$.agentId') = ${agentId}`)).get();
      const invocationId = typeof asRecord(binding?.metadata)?.invocationId === 'string' ? asRecord(binding!.metadata)!.invocationId as string : root?.id ?? targetExecutionId;
      const message = typeof input?.task === 'string' ? input.task : JSON.stringify(input?.task ?? '');
      const background = await this.continue(request, workspaceSlug, agentId, targetExecutionId, { message }, (tx) => {
        tx.update(agentToolCalls).set({ input: { ...input, executionId: targetExecutionId, __backgroundExecutionId: targetExecutionId, __agentInvocationId: invocationId, __agentName: agent.name } }).where(eq(agentToolCalls.id, call.id)).run();
        const metadata = { conversationId, toolCallId: call.id, agentId, agentName: agent.name, invocationId };
        if (binding) tx.update(auditLogs).set({ metadata }).where(eq(auditLogs.id, binding.id)).run();
        else tx.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId, action: 'chat_agent.dispatched', resource: targetExecutionId, metadata }).run();
        this.queueWechatAgentDispatch(tx, workspaceId, conversationId, call.id, agent.name, input.task);
      });
      return JSON.stringify({ status: 'running', executionId: background.id, agentId, agentName: agent.name, runId: invocationId, background: true, continued: true, message: '原 Agent 实例已继续执行，结果会自动汇报。' });
    }
    let invocationId = selected.runtime.kind === 'native' && selected.collaboration
      ? mention && decodeURIComponent(mention[1]!) === agentId ? mention[2]! : `air_${randomUUID()}`
      : '';
    if (invocationId && this.db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.id, invocationId)).get()) invocationId = `air_${randomUUID()}`;
    const message = typeof input?.task === 'string' ? input.task : JSON.stringify(input?.task ?? '');
    const background = await this.create(request, workspaceSlug, agentId, { message, projectDirectory: typeof input?.projectDirectory === 'string' ? input.projectDirectory : undefined }, (tx, executionId) => {
      invocationId ||= executionId;
      tx.update(agentToolCalls).set({ input: { ...input, __backgroundExecutionId: executionId, __agentInvocationId: invocationId, __agentName: agent.name } }).where(eq(agentToolCalls.id, call.id)).run();
      tx.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId, action: 'chat_agent.dispatched', resource: executionId, metadata: { conversationId, toolCallId: call.id, agentId, agentName: agent.name, invocationId } }).run();
      this.queueWechatAgentDispatch(tx, workspaceId, conversationId, call.id, agent.name, input.task);
    });
    return JSON.stringify({ status: 'running', executionId: background.id, agentId, agentName: agent.name, runId: invocationId, background: true, message: 'Agent 已在后台启动。Chat 可以继续对话，完成或失败后会自动汇报；不要等待或轮询，不要将启动成功当作任务完成。' });
  }

  private queueWechatAgentDispatch(transaction: AcceptanceTransaction, workspaceId: string, conversationId: string, callId: string, agentName: string, task: unknown): void {
    const chat = transaction.select({ id: externalChats.id }).from(externalChats).where(and(eq(externalChats.workspaceId, workspaceId), eq(externalChats.executionId, conversationId), eq(externalChats.channel, 'wechat'))).get();
    if (!chat || typeof task !== 'string') return;
    // Freeze a short plain-text snapshot, never a model reply or a media reference. Missing
    // usable content stays silent instead of inventing a task or exposing serialized input.
    const name = shortDispatchText(agentName, 40);
    const summary = shortDispatchText(task, 120);
    if (!name || !summary) return;
    transaction.insert(chatSubmissions).values({
      id: `dispatch_${callId}`, workspaceId, chatId: chat.id, executionId: conversationId, message: '', target: { kind: 'conversation' },
      reference: { kind: 'conversation', executionId: conversationId, afterMessageId: null, afterSequence: 0, completionStatus: 'completed', dispatchNotice: `已派 @${name}：${summary}，正在执行` },
    }).onConflictDoNothing().run();
  }

  private readonly backgroundAgentReportTimers = new Map<string, NodeJS.Timeout>();

  private scheduleBackgroundAgentReports(workspaceId?: string, relatedExecutionId?: string): void {
    const bindings = this.db.select().from(auditLogs).where(and(eq(auditLogs.action, 'chat_agent.dispatched'), workspaceId ? eq(auditLogs.workspaceId, workspaceId) : undefined, relatedExecutionId ? or(eq(auditLogs.resource, relatedExecutionId), sql`json_extract(${auditLogs.metadata}, '$.conversationId') = ${relatedExecutionId}`) : undefined, sql`coalesce(json_extract(${auditLogs.metadata}, '$.reportedStatus'), '') not in ('completed', 'failed', 'cancelled')`)).all();
    for (const binding of bindings) {
      const meta = asRecord(binding.metadata);
      if ((workspaceId && binding.workspaceId !== workspaceId) || (relatedExecutionId && binding.resource !== relatedExecutionId && meta?.conversationId !== relatedExecutionId) || this.backgroundAgentReportTimers.has(binding.id)) continue;
      const timer = setTimeout(() => {
        this.backgroundAgentReportTimers.delete(binding.id);
        void this.reportBackgroundAgent(binding.id).catch((error) => this.logger.warn(`Background Agent report failed: ${error instanceof Error ? error.message : String(error)}`));
      }, 0);
      timer.unref();
      this.backgroundAgentReportTimers.set(binding.id, timer);
    }
  }

  private async reportBackgroundAgent(bindingId: string): Promise<void> {
    const binding = this.db.select().from(auditLogs).where(eq(auditLogs.id, bindingId)).get();
    if (!binding) return;
    const meta = asRecord(binding.metadata)!;
    const task = this.db.select(agentExecutionColumns).from(agentExecutions).where(and(eq(agentExecutions.id, binding.resource), eq(agentExecutions.workspaceId, binding.workspaceId))).get();
    if (!task || !['completed', 'failed', 'cancelled', 'waiting_for_input'].includes(task.status) || typeof meta.conversationId !== 'string') return;
    const reportKey = task.status === 'waiting_for_input' ? `${task.status}:${task.pendingQuestion?.id ?? task.updatedAt.toISOString()}` : task.status;
    if (meta.reportedKey === reportKey) return;
    let accepted = false;
    this.db.transaction((tx) => {
      const conversation = tx.select(agentExecutionColumns).from(agentExecutions).where(and(eq(agentExecutions.id, meta.conversationId as string), eq(agentExecutions.workspaceId, binding.workspaceId), eq(agentExecutions.agentId, CHAT_AGENT_ID))).get();
      const current = tx.select().from(auditLogs).where(eq(auditLogs.id, bindingId)).get();
      if (!conversation || ['running', 'waiting_for_input'].includes(conversation.status) || asRecord(current?.metadata)?.reportedKey === reportKey) return;
      const output = task.displayMessages.filter((message) => message.role === 'assistant').map((message) => message.content).join('\n\n');
      const note = `[后台 Agent 执行结果] ${JSON.stringify({ agentName: meta.agentName, agentId: task.agentId, executionId: task.id, runId: meta.invocationId, status: task.status, task: task.displayMessages.find((message) => message.role === 'user')?.content, output: output.slice(-24000), error: task.error, pendingQuestion: task.pendingQuestion })}\n仅向用户汇报这个已发生的结果；区分成功、失败、取消和待回答。不要重新派发任务、等待或轮询。`;
      tx.update(agentExecutions).set(executionUpdates(conversation.id, { status: 'running', phase: 'model', error: null, errorCode: null, modelMessages: appendExecutionMessages(conversation.id, 'model', [{ role: 'user', content: note }]), updatedAt: new Date() })).where(eq(agentExecutions.id, conversation.id)).run();
      tx.update(auditLogs).set({ metadata: { ...meta, reportedStatus: task.status, reportedKey: reportKey } }).where(eq(auditLogs.id, bindingId)).run();
      this.openConversationReportWindow(tx, binding.workspaceId, conversation.id, conversation.displayMessages);
      accepted = true;
    });
    if (accepted) {
      await this.publishSnapshotForExecution(binding.workspaceId, meta.conversationId as string);
      this.schedule({} as Request, 'personal', meta.conversationId as string);
    }
  }

  private async answerShell(request: Request, workspaceSlug: string, workspaceId: string, executionId: string, input: AnswerAgentQuestionRequest, accept?: ConversationAcceptance): Promise<AgentExecutionView> {
    const execution = await this.loadExecution(workspaceId, CHAT_AGENT_ID, executionId);
    const question = execution.pendingQuestion;
    const [call] = await this.db.select().from(agentToolCalls).where(and(eq(agentToolCalls.id, question?.shellCallId ?? ''), eq(agentToolCalls.executionId, executionId))).limit(1);
    if (!question || question.id !== input.questionId || execution.status !== 'waiting_for_input' || !call?.shell || call.resultAppended) throw new ConflictException('This Shell question is no longer active.');
    if (!question.recovery) throw new ConflictException('旧命令授权已停用，请停止本轮并重新发送请求，确认执行方案。');
    let result: AgentScriptExecutionResult;
    if (input.recoveryDecision === 'adopt_command') {
      if (!call.commandExecutionId) throw new ConflictException('There is no linked Command to adopt.');
      const command = await this.commands.get(call.commandExecutionId);
      if (!['succeeded', 'failed', 'cancelled'].includes(command.status) || command.exitCode === null) throw new ConflictException('The Command has no confirmed terminal result; mark the call failed instead.');
      result = { status: command.status === 'succeeded' ? 'completed' : command.status === 'cancelled' ? 'cancelled' : 'failed', output: await this.commands.output(command.id), exitCode: command.exitCode, commandExecutionId: command.id, result: null };
    } else if (input.recoveryDecision === 'mark_failed') {
      let exitCode: number | null = null;
      if (call.commandExecutionId) {
        await this.commands.cancel(call.commandExecutionId);
        exitCode = (await this.commands.waitForCompletion(call.commandExecutionId)).exitCode;
      }
      result = { status: 'failed', output: [call.commandExecutionId ? await this.commands.output(call.commandExecutionId) : '', '用户已标记此 Shell 调用失败，命令没有重新执行。'].filter(Boolean).join('\n'), exitCode, commandExecutionId: call.commandExecutionId, result: null };
    } else throw new BadRequestException('Select a structured Shell recovery decision.');
    const shell = { ...call.shell, state: 'settled' as const };
    this.db.transaction((transaction) => {
      const updated = transaction.update(agentExecutions).set({ status: 'running', phase: 'skill', pendingQuestion: null, updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'waiting_for_input'), sql`json_extract(${agentExecutions.pendingQuestion}, '$.id') = ${input.questionId}`)).run();
      if (!updated.changes) throw new ConflictException('This Shell question has already been answered.');
      transaction.update(agentToolCalls).set({ shell, ...result, finishedAt: new Date() }).where(eq(agentToolCalls.id, call.id)).run();
      accept?.(transaction, executionId);
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId, action: 'chat_shell.settled', resource: call.id, metadata: { executionId, questionId: input.questionId, commandExecutionId: call.commandExecutionId, recoveryDecision: input.recoveryDecision ?? null } }).run();
    });
    await this.publishSnapshotForExecution(workspaceId, executionId);
    void this.resumeAfterToolCalls(request, workspaceSlug, workspaceId, CHAT_AGENT_ID, executionId).catch((error) => this.failBackgroundExecution(workspaceId, executionId, error));
    return this.toView(await this.loadExecution(workspaceId, CHAT_AGENT_ID, executionId));
  }

  private async retryShell(request: Request, workspaceSlug: string, workspaceId: string, executionId: string, call: typeof agentToolCalls.$inferSelect): Promise<AgentExecutionView> {
    const shell = call.shell!;
    const recovery = shell.state !== 'settled' && (Boolean(call.commandExecutionId) || shell.state === 'reserved' || shell.state === 'uncertain');
    const pendingQuestion = recovery ? shellRecoveryQuestion(call) : null;
    this.db.transaction((transaction) => {
      const updated = transaction.update(agentExecutions).set({ status: pendingQuestion ? 'waiting_for_input' : 'running', phase: recovery ? 'recovery' : 'skill', pendingQuestion, error: null, errorCode: null, updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'failed'))).run();
      if (!updated.changes) throw new ConflictException('This Shell call is no longer ready to retry.');
      if (shell.state !== 'settled') transaction.update(agentToolCalls).set({ status: 'running', finishedAt: null, shell: { ...shell, state: recovery ? 'uncertain' : shell.state } }).where(eq(agentToolCalls.id, call.id)).run();
    });
    await this.publishSnapshotForExecution(workspaceId, executionId);
    if (!pendingQuestion) {
      const continuation = shell.state === 'settled'
        ? this.resumeAfterToolCalls(request, workspaceSlug, workspaceId, CHAT_AGENT_ID, executionId)
        : this.executeShell(request, workspaceSlug, workspaceId, executionId, call);
      void continuation.catch((error) => this.failBackgroundExecution(workspaceId, executionId, error));
    }
    return this.toView(await this.loadExecution(workspaceId, CHAT_AGENT_ID, executionId));
  }

  private async executeShell(request: Request, workspaceSlug: string, workspaceId: string, executionId: string, call: typeof agentToolCalls.$inferSelect): Promise<void> {
    if (call.commandExecutionId || call.shell?.state === 'reserved' || call.shell?.state === 'uncertain') {
      await this.db.update(agentExecutions).set({ status: 'waiting_for_input', phase: 'recovery', pendingQuestion: shellRecoveryQuestion(call), updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running')));
    } else {
      await this.db.update(agentToolCalls).set({ status: 'failed', shell: call.shell ? { ...call.shell, state: 'settled' } : null, output: 'Direct Shell execution is unavailable to Chat. Delegate the requested task to a project executor.', finishedAt: new Date() }).where(and(eq(agentToolCalls.id, call.id), eq(agentToolCalls.status, 'running')));
    }
    await this.publishSnapshotForExecution(workspaceId, executionId);
    await this.resumeAfterToolCalls(request, workspaceSlug, workspaceId, CHAT_AGENT_ID, executionId);
  }

  private async executeHostCommand(request: Request, workspaceSlug: string, workspaceId: string, executionId: string, call: typeof agentToolCalls.$inferSelect): Promise<void> {
    const abortController = new AbortController();
    this.activeHostCommands.set(call.id, abortController);
    try {
      await this.executeHostCommandOnce(request, workspaceSlug, workspaceId, executionId, call, abortController.signal);
    } catch (error) {
      this.logger.warn(`Chat host command ${call.id} failed before it could settle: ${error instanceof Error ? error.message : String(error)}`);
      const output = 'Failed: run_host_command could not complete inside WorkLite. No command output is available; inspect the recorded command and working directory before retrying.';
      const finishedAt = new Date();
      let settled = false;
      this.db.transaction((transaction) => {
        const updated = transaction.update(agentToolCalls).set({ status: 'failed', output, finishedAt })
          .where(and(eq(agentToolCalls.id, call.id), eq(agentToolCalls.status, 'running'))).run();
        if (updated.changes === 0) return;
        settled = true;
        transaction.insert(auditLogs).values({
          id: `audit_${randomUUID()}`, workspaceId, action: 'chat_host_command.failed', resource: call.id,
          metadata: { agentId: CHAT_AGENT_ID, executionId, toolName: 'run_host_command', internalFailure: true },
        }).run();
      });
      if (settled) {
        const [updatedCall] = await this.db.select().from(agentToolCalls).where(eq(agentToolCalls.id, call.id)).limit(1);
        if (updatedCall) await this.persistEvent(executionId, { kind: 'tool_call', call: toToolCallView(updatedCall) });
      }
      await this.publishSnapshotForExecution(workspaceId, executionId);
      await this.resumeAfterToolCalls(request, workspaceSlug, workspaceId, CHAT_AGENT_ID, executionId);
    } finally {
      if (this.activeHostCommands.get(call.id) === abortController) this.activeHostCommands.delete(call.id);
    }
  }

  private async executeHostCommandOnce(request: Request, workspaceSlug: string, workspaceId: string, executionId: string, call: typeof agentToolCalls.$inferSelect, signal: AbortSignal): Promise<void> {
    const turn = await this.loadExecution(workspaceId, CHAT_AGENT_ID, executionId);
    if (turn.status !== 'running') return;
    const platformSkill = turn.capabilitySnapshot?.skills.find((skill) => isProtectedPlatformSkillId(workspaceId, skill.id));
    if (!platformSkill || !platformRuntimeTool(platformSkill.files, 'run_host_command')) {
      const output = 'Rejected: run_host_command requires the protected worklite-platform Skill and its runtime tool declaration in this conversation turn.';
      await this.db.update(agentToolCalls).set({ status: 'failed', output, finishedAt: new Date() }).where(and(eq(agentToolCalls.id, call.id), eq(agentToolCalls.status, 'running')));
      await this.publishSnapshotForExecution(workspaceId, executionId);
      await this.resumeAfterToolCalls(request, workspaceSlug, workspaceId, CHAT_AGENT_ID, executionId);
      return;
    }
    const result: ChatHostCommandResult = await this.hostCommands.run(call.input, signal, undefined, this.nativeToolProgress.get(call.id));
    const finishedAt = new Date();
    let finalized = false;
    this.db.transaction((transaction) => {
      const update = hostCommandToolCallUpdate(result);
      const updated = transaction.update(agentToolCalls).set({ ...update, finishedAt }).where(and(eq(agentToolCalls.id, call.id), eq(agentToolCalls.status, 'running'))).run();
      if (updated.changes === 0) {
        const cancelled = transaction.update(agentToolCalls).set({ ...update, status: 'cancelled', finishedAt })
          .where(and(eq(agentToolCalls.id, call.id), eq(agentToolCalls.status, 'cancelled'))).run();
        if (cancelled.changes === 0) return;
      }
      finalized = true;
      transaction.insert(auditLogs).values({
        id: `audit_${randomUUID()}`, workspaceId, action: `chat_host_command.${result.status}`, resource: call.id,
        metadata: { agentId: CHAT_AGENT_ID, executionId, toolName: 'run_host_command', command: result.command, cwd: result.cwd, exitCode: result.exitCode, durationMs: result.durationMs, timedOut: result.timedOut, cancelled: result.cancelled, rejected: result.rejected, stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated, outputTruncated: result.outputTruncated },
      }).run();
    });
    if (!finalized) return;
    const [updatedCall] = await this.db.select().from(agentToolCalls).where(eq(agentToolCalls.id, call.id)).limit(1);
    if (updatedCall) await this.persistEvent(executionId, { kind: 'tool_call', call: toToolCallView(updatedCall) });
    await this.publishSnapshotForExecution(workspaceId, executionId);
    await this.resumeAfterToolCalls(request, workspaceSlug, workspaceId, CHAT_AGENT_ID, executionId);
  }

  private async executeProjectTaskTool(request: Request, workspaceSlug: string, workspaceId: string, executionId: string, call: typeof agentToolCalls.$inferSelect): Promise<void> {
    let task: Awaited<ReturnType<ChatProjectTasksService['capture']>>;
    try { task = await this.projectTasks.capture(workspaceId, executionId, call.id, call.input); }
    catch (error) {
      const output = projectTaskCaptureFailureMessage(error);
      await this.db.update(agentToolCalls).set({ status: 'failed', output, finishedAt: new Date() }).where(and(eq(agentToolCalls.id, call.id), eq(agentToolCalls.status, 'running')));
      await this.publishSnapshotForExecution(workspaceId, executionId);
      await this.resumeAfterToolCalls(request, workspaceSlug, workspaceId, CHAT_AGENT_ID, executionId);
      return;
    }
    const current = await this.loadExecution(workspaceId, CHAT_AGENT_ID, executionId);
    if (current.status !== 'running') { await this.projectTasks.cancel(call.id); return; }
    // Dispatch-and-return: the executor runs in the background while this turn settles immediately.
    this.startProjectTaskBackground(workspaceId, executionId, call.id);
    this.db.transaction((transaction) => {
      transaction.update(agentToolCalls).set({ status: 'completed', output: `项目任务已在后台启动（taskId: ${task.id}，工作区: ${task.projectDirectory}${task.worktreePath ? `，历史任务 worktree: ${task.worktreePath}（分支 ${task.worktreeBranch}，按捕获的旧策略处理）` : '；新任务的 Git 分支与项目级 worktree 由执行器自行判断和管理，WorkLite 不自动合并'}）。本轮对话可立即继续回答用户；任务进展持续显示在任务卡片中，完成、失败或需要用户回答时会自动汇报，无需等待或轮询。`, finishedAt: new Date() }).where(and(eq(agentToolCalls.id, call.id), eq(agentToolCalls.status, 'running'))).run();
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId, action: 'chat_project_task.dispatched', resource: call.id, metadata: { executionId, taskId: call.id } }).run();
    });
    await this.publishSnapshotForExecution(workspaceId, executionId);
    await this.resumeAfterToolCalls(request, workspaceSlug, workspaceId, CHAT_AGENT_ID, executionId);
  }

  private startProjectTaskBackground(workspaceId: string, executionId: string, taskId: string): void {
    void this.projectTasks.run(taskId, async () => {
      const view = this.projectTasks.view(taskId);
      const backend = [...view.activities].reverse().find((activity) => typeof activity.commandExecutionId === 'string' && /^(codex|claude)\./.test(String(activity.phase)));
      // The originating tool call has already settled, so progress linkage updates without a status guard.
      await this.db.update(agentToolCalls).set({ workingDirectory: view.worktreePath ?? view.projectDirectory, commandExecutionId: typeof backend?.commandExecutionId === 'string' ? backend.commandExecutionId : null }).where(eq(agentToolCalls.id, taskId));
      await this.publishSnapshotForExecution(workspaceId, executionId);
    }, (settled) => this.scheduleProjectTaskReport(workspaceId, executionId, settled.id),
    // A live Claude question parks the round without settling it; report the question now.
    (waiting) => {
      void this.publishSnapshotForExecution(workspaceId, executionId)
        .catch((error) => this.logger.warn(`Project task ${taskId} snapshot failed: ${error instanceof Error ? error.message : String(error)}`));
      this.scheduleProjectTaskReport(workspaceId, executionId, waiting.id);
    })
      .catch((error) => this.logger.warn(`Chat project task ${taskId} background run failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  private readonly projectTaskReportTimers = new Map<string, NodeJS.Timeout>();

  private scheduleProjectTaskReport(workspaceId: string, executionId: string, taskId: string, delayMs = 0, deferredAttempts = 0): void {
    if (this.projectTaskReportTimers.has(taskId)) return;
    const timer = setTimeout(() => {
      this.projectTaskReportTimers.delete(taskId);
      void this.reportProjectTaskSettled(workspaceId, executionId, taskId, deferredAttempts)
        .catch((error) => this.logger.warn(`Chat project task ${taskId} report failed: ${error instanceof Error ? error.message : String(error)}`));
    }, delayMs);
    this.projectTaskReportTimers.set(taskId, timer);
  }

  // One automatic report turn per task settlement: the notification is model-only, so the transcript
  // shows only the assistant's brief report. A busy conversation defers the report until it idles.
  private async reportProjectTaskSettled(workspaceId: string, executionId: string, taskId: string, deferredAttempts = 0): Promise<void> {
    const task = await this.db.select(projectTaskColumns).from(chatProjectTasks).where(eq(chatProjectTasks.id, taskId)).get();
    if (!task || task.reportedAt) return;
    if (task.status !== 'succeeded' && task.status !== 'failed' && task.status !== 'waiting_for_input') return;
    // Fan out to cross-conversation subscriptions independently of the owning conversation's state.
    for (const subscription of this.projectTasks.subscriptionsFor(taskId)) {
      this.scheduleSubscriptionReport(workspaceId, subscription.subscriberExecutionId, taskId, subscription.id);
    }
    const execution = await this.loadExecution(workspaceId, CHAT_AGENT_ID, executionId);
    if (execution.status === 'running' || execution.status === 'waiting_for_input') {
      // A conversation blocked for hours keeps its unreported marker for the startup sweep instead of polling forever.
      if (deferredAttempts < 240) this.scheduleProjectTaskReport(workspaceId, executionId, taskId, 15000, deferredAttempts + 1);
      return;
    }
    const note = buildTaskReportNote(task, false);
    let accepted = false;
    this.db.transaction((transaction) => {
      const updated = transaction.update(agentExecutions).set(executionUpdates(executionId, {
        status: 'running', phase: 'model', errorCode: null, error: null,
        modelMessages: appendExecutionMessages(executionId, 'model', [{ role: 'user', content: note }]),
        updatedAt: new Date(),
      })).where(and(eq(agentExecutions.id, executionId), inArray(agentExecutions.status, ['completed', 'cancelled', 'failed']))).run();
      if (updated.changes === 0) return;
      accepted = true;
      transaction.update(chatProjectTasks).set({ reportedAt: new Date() }).where(eq(chatProjectTasks.id, taskId)).run();
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId, action: `chat_project_task.${task.status}`, resource: taskId, metadata: { executionId, taskId, report: true } }).run();
      this.openConversationReportWindow(transaction, workspaceId, executionId, execution.displayMessages);
    });
    if (!accepted) {
      if (deferredAttempts < 240) this.scheduleProjectTaskReport(workspaceId, executionId, taskId, 15000, deferredAttempts + 1);
      return;
    }
    await this.publishSnapshotForExecution(workspaceId, executionId);
    // The report turn runs outside an HTTP request; the workspace and model runtime resolve without one.
    this.schedule({} as Request, 'personal', executionId);
  }

  // New subscriptions on an already-settled task report immediately rather than at next boot.
  scheduleSettledSubscriptionReports(workspaceId: string, taskId: string): void {
    const task = this.db.select(projectTaskColumns).from(chatProjectTasks).where(eq(chatProjectTasks.id, taskId)).get();
    if (!task || (task.status !== 'succeeded' && task.status !== 'failed' && task.status !== 'waiting_for_input')) return;
    for (const subscription of this.projectTasks.subscriptionsFor(taskId)) {
      this.scheduleSubscriptionReport(workspaceId, subscription.subscriberExecutionId, taskId, subscription.id);
    }
  }

  private scheduleSubscriptionReport(workspaceId: string, executionId: string, taskId: string, subscriptionId: string, delayMs = 0, deferredAttempts = 0): void {
    const key = `sub:${subscriptionId}`;
    if (this.projectTaskReportTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.projectTaskReportTimers.delete(key);
      void this.reportProjectTaskToSubscriber(workspaceId, executionId, taskId, subscriptionId, deferredAttempts)
        .catch((error) => this.logger.warn(`Chat project task ${taskId} subscription report failed: ${error instanceof Error ? error.message : String(error)}`));
    }, delayMs);
    this.projectTaskReportTimers.set(key, timer);
  }

  // The same report mechanism as the owning conversation, into a subscribed conversation; the
  // subscription row is consumed once the report is accepted.
  private async reportProjectTaskToSubscriber(workspaceId: string, executionId: string, taskId: string, subscriptionId: string, deferredAttempts = 0): Promise<void> {
    const task = await this.db.select(projectTaskColumns).from(chatProjectTasks).where(eq(chatProjectTasks.id, taskId)).get();
    if (!task || task.status === 'cancelled') {
      this.projectTasks.consumeSubscription(subscriptionId);
      return;
    }
    if (task.status === 'running') {
      // The task was answered and re-ran after its previous settle; keep the one-shot
      // subscription armed for the next settlement.
      if (deferredAttempts < 240) this.scheduleSubscriptionReport(workspaceId, executionId, taskId, subscriptionId, 15000, deferredAttempts + 1);
      return;
    }
    if (task.status !== 'succeeded' && task.status !== 'failed' && task.status !== 'waiting_for_input') return;
    const execution = await this.loadExecution(workspaceId, CHAT_AGENT_ID, executionId);
    if (execution.status === 'running' || execution.status === 'waiting_for_input') {
      if (deferredAttempts < 240) this.scheduleSubscriptionReport(workspaceId, executionId, taskId, subscriptionId, 15000, deferredAttempts + 1);
      return;
    }
    const note = buildTaskReportNote(task, true);
    let accepted = false;
    this.db.transaction((transaction) => {
      const updated = transaction.update(agentExecutions).set(executionUpdates(executionId, {
        status: 'running', phase: 'model', errorCode: null, error: null,
        modelMessages: appendExecutionMessages(executionId, 'model', [{ role: 'user', content: note }]),
        updatedAt: new Date(),
      })).where(and(eq(agentExecutions.id, executionId), inArray(agentExecutions.status, ['completed', 'cancelled', 'failed']))).run();
      if (updated.changes === 0) return;
      accepted = true;
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId, action: `chat_project_task.${task.status}`, resource: taskId, metadata: { executionId, taskId, report: true, subscriptionId } }).run();
      this.openConversationReportWindow(transaction, workspaceId, executionId, execution.displayMessages);
    });
    if (!accepted) {
      if (deferredAttempts < 240) this.scheduleSubscriptionReport(workspaceId, executionId, taskId, subscriptionId, 15000, deferredAttempts + 1);
      return;
    }
    this.projectTasks.consumeSubscription(subscriptionId);
    await this.publishSnapshotForExecution(workspaceId, executionId);
    this.schedule({} as Request, 'personal', executionId);
  }

  // One automatic report turn per settled Coder Run dispatched from this conversation. The caller
  // (ChatTeamRunReportsService) owns submission resolution, the note content and busy-deferral.
  async reportTeamRunSettled(workspaceId: string, executionId: string, submissionId: string, note: string): Promise<'reported' | 'busy'> {
    const execution = await this.loadExecution(workspaceId, CHAT_AGENT_ID, executionId);
    if (execution.status === 'running' || execution.status === 'waiting_for_input') return 'busy';
    let accepted = false;
    let busy = false;
    this.db.transaction((transaction) => {
      const updated = transaction.update(agentExecutions).set(executionUpdates(executionId, {
        status: 'running', phase: 'model', errorCode: null, error: null,
        modelMessages: appendExecutionMessages(executionId, 'model', [{ role: 'user', content: note }]),
        updatedAt: new Date(),
      })).where(and(eq(agentExecutions.id, executionId), inArray(agentExecutions.status, ['completed', 'cancelled', 'failed']))).run();
      if (updated.changes === 0) { busy = true; return; }
      accepted = true;
      transaction.update(chatSubmissions).set({ reportedAt: new Date() }).where(eq(chatSubmissions.id, submissionId)).run();
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId, action: 'chat_team_run.reported', resource: submissionId, metadata: { executionId, submissionId, report: true } }).run();
    });
    if (busy) return 'busy';
    if (!accepted) return 'reported';
    await this.publishSnapshotForExecution(workspaceId, executionId);
    // The report turn runs outside an HTTP request; the workspace and model runtime resolve without one.
    this.schedule({} as Request, 'personal', executionId);
    return 'reported';
  }

  // One progress report turn while the conversation has active background work. Unlike the
  // one-shot settlement reports nothing is recorded per task or Run: the caller
  // (ChatProgressReportsService) throttles by change signature and interval. A cancelled
  // conversation stops receiving progress reports, matching the cancel-stops-reporting rule.
  async reportActiveWorkProgress(workspaceId: string, executionId: string, note: string, progressReport: ChatProgressReport): Promise<'reported' | 'busy' | 'unavailable'> {
    const execution = await this.loadExecution(workspaceId, CHAT_AGENT_ID, executionId).catch(() => null);
    if (!execution || execution.status === 'cancelled') return 'unavailable';
    if (execution.status === 'running' || execution.status === 'waiting_for_input') return 'busy';
    let accepted = false;
    this.db.transaction((transaction) => {
      const updated = transaction.update(agentExecutions).set(executionUpdates(executionId, {
        status: 'running', phase: 'model', errorCode: null, error: null,
        modelMessages: appendExecutionMessages(executionId, 'model', [{ role: 'user', content: note }]),
        updatedAt: new Date(),
      })).where(and(eq(agentExecutions.id, executionId), inArray(agentExecutions.status, ['completed', 'failed']))).run();
      if (updated.changes === 0) return;
      accepted = true;
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId, action: 'chat_progress.reported', resource: executionId, metadata: { executionId, report: 'progress' } }).run();
      this.openConversationReportWindow(transaction, workspaceId, executionId, execution.displayMessages);
    });
    if (!accepted) return 'busy';
    await this.publishSnapshotForExecution(workspaceId, executionId);
    // The report turn runs outside an HTTP request; the workspace and model runtime resolve without one.
    this.schedule({} as Request, 'personal', executionId, progressReport);
    return 'reported';
  }

  // A background report (project task settlement or periodic active-work progress) appends its
  // reply to the execution's own message history, which Web already streams live. But the
  // conversation's most recent 'conversation'-kind chatSubmissions row was frozen (completionStatus
  // set, settled=true) when its own turn ended, and nothing else reopens that window — so a
  // channel adapter whose delivery sweep only redelivers settled=false rows (WeChat, Feishu) never
  // sees the new reply. Opening a fresh, narrowly-scoped row per report mirrors how upgrades.service
  // already injects a mid-execution notification, and keeps the window just the new reply instead
  // of replaying everything already delivered.
  private openConversationReportWindow(transaction: AcceptanceTransaction, workspaceId: string, executionId: string, beforeMessages: StoredAgentDisplayMessage[]): void {
    const chat = transaction.select({ id: externalChats.id }).from(externalChats).where(eq(externalChats.executionId, executionId)).limit(1).get();
    if (!chat) return;
    const reference: ChatTaskReference = { kind: 'conversation', executionId, afterMessageId: beforeMessages.at(-1)?.id ?? null, afterSequence: 0 };
    transaction.insert(chatSubmissions).values({
      id: `report_${randomUUID()}`, workspaceId, chatId: chat.id, executionId, message: '', target: { kind: 'conversation' }, reference,
    }).run();
  }

  private async executeProjectTaskControlTool(request: Request, workspaceSlug: string, workspaceId: string, executionId: string, call: typeof agentToolCalls.$inferSelect): Promise<void> {
    const input = call.input as { taskId?: unknown; questionId?: unknown; answer?: unknown; text?: unknown };
    const taskId = typeof input?.taskId === 'string' ? input.taskId : '';
    let output: string;
    let failed = false;
    try {
      if (call.mcpToolName === 'cancel_project_task') {
        this.projectTasks.view(taskId, workspaceId);
        const task = await this.projectTasks.cancel(taskId);
        output = `项目任务已取消（taskId: ${task.id}，状态: ${task.status}）。`;
      } else if (call.mcpToolName === 'steer_project_task') {
        const view = this.projectTasks.view(taskId, workspaceId);
        const updated = await this.projectTasks.steer(workspaceId, taskId, typeof input?.text === 'string' ? input.text : '');
        await this.publishSnapshotForExecution(workspaceId, view.executionId);
        output = projectTaskSteerOutput(updated);
      } else {
        const questionId = typeof input?.questionId === 'string' ? input.questionId : '';
        const answer = typeof input?.answer === 'string' ? input.answer : '';
        const task = await this.projectTasks.answer(workspaceId, taskId, { questionId, answer }, () => undefined);
        this.startProjectTaskBackground(workspaceId, task.executionId, task.id);
        output = `已提交回答，项目任务继续运行（taskId: ${task.id}）。任务结束或再次需要回答时会自动汇报。`;
      }
    } catch (error) {
      failed = true;
      output = error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException ? error.message : '项目任务操作失败。';
    }
    this.db.transaction((transaction) => {
      transaction.update(agentToolCalls).set({ status: failed ? 'failed' : 'completed', output, finishedAt: new Date() }).where(and(eq(agentToolCalls.id, call.id), eq(agentToolCalls.status, 'running'))).run();
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId, action: `${call.mcpToolName}.${failed ? 'failed' : 'completed'}`, resource: call.id, metadata: { executionId, taskId } }).run();
    });
    await this.publishSnapshotForExecution(workspaceId, executionId);
    await this.resumeAfterToolCalls(request, workspaceSlug, workspaceId, CHAT_AGENT_ID, executionId);
  }

  private async resumeAfterToolCalls(request: Request, workspaceSlug: string, workspaceId: string, agentId: string, executionId: string): Promise<AgentExecutionView> {
    if (this.activeNativeBatches.has(executionId)) return this.toView(await this.loadExecution(workspaceId, agentId, executionId));
    const activeExecution = await this.loadExecution(workspaceId, agentId, executionId);
    if (activeExecution.status !== 'running') return this.toView(activeExecution);
    // The engine owns its tool loop; MCP returns results to that same live session.
    if (agentId !== CHAT_AGENT_ID && activeExecution.capabilitySnapshot?.agent.runtime && activeExecution.capabilitySnapshot.agent.runtime.kind !== 'native') {
      this.db.update(agentExecutions).set({ phase: 'model', updatedAt: new Date() }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running'))).run();
      await this.publishSnapshotForExecution(workspaceId, executionId);
      return this.toView(activeExecution);
    }
    let shouldAdvance = false;
    let dispatchOnly = false;
    this.db.transaction((transaction) => {
      const execution = transaction.select(agentExecutionColumns).from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.agentId, agentId), eq(agentExecutions.workspaceId, workspaceId))).get();
      if (!execution || execution.status !== 'running') return;
      const calls = transaction.select().from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.resultAppended, false))).all();
      if (!calls.length || calls.some((call) => call.status === 'running')) return;
    const toolResults = calls.map((call) => ({ type: 'tool-result' as const, toolCallId: call.toolCallId, toolName: modelToolName(call), output: toolCallOutput(call, workspaceId) }));
    const modelMessages = insertAgentToolResults(execution.modelMessages, toolResults);
    // A successful dispatch is already presented by its task card. Settle this Chat
    // turn without asking the model to write a second launch acknowledgement.
    // Failed dispatches and batches with other work still need the normal model step.
    dispatchOnly = agentId === CHAT_AGENT_ID
      && calls.some((call) => call.mcpToolName === 'run_agent' && typeof asRecord(call.input)?.__backgroundExecutionId === 'string')
      && calls.every((call) => call.status === 'completed' && call.toolName === 'builtin' && (call.mcpToolName === 'run_agent' || call.mcpToolName === 'update_plan'));
      const updated = transaction.update(agentExecutions).set(executionUpdates(executionId, { status: dispatchOnly ? 'completed' : 'running', phase: 'model', modelMessages, updatedAt: new Date() })).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running'))).run();
      if (updated.changes === 0) return;
      shouldAdvance = true;
      for (const call of calls) transaction.update(agentToolCalls).set({ resultAppended: true }).where(eq(agentToolCalls.id, call.id)).run();
      if (dispatchOnly) {
        transaction.update(agentSubSessions).set({ unread: true, updatedAt: new Date() }).where(eq(agentSubSessions.executionId, executionId)).run();
        transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId, action: 'agent_execution.completed', resource: executionId, metadata: { agentId, executionId, phase: 'model', errorCode: null } }).run();
      }
    });
    if (!shouldAdvance) return this.toView(await this.loadExecution(workspaceId, agentId, executionId));
    await this.publishSnapshotForExecution(workspaceId, executionId);
    if (dispatchOnly) {
      const settled = await this.loadExecution(workspaceId, agentId, executionId);
      if (settled.queuedMessages.length) return this.advance(request, workspaceSlug, executionId);
      return this.toView(settled);
    }
    return this.advance(request, workspaceSlug, executionId);
  }

  private captureCapabilities(transaction: AcceptanceTransaction, workspaceId: string, agentId: string) {
    if (agentId !== CHAT_AGENT_ID) {
      const agent = transaction.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId))).get();
      if (!agent || agent.runtime.kind === 'native') return null;
      const selected = transaction.select({ id: skills.id, name: skills.name, instructions: skills.instructions, validation: skills.validation }).from(agentSkills).innerJoin(skills, eq(agentSkills.skillId, skills.id)).where(and(eq(agentSkills.agentId, agentId), eq(skills.workspaceId, workspaceId))).all();
      const fileEntry = agentFiles(this.db)?.get(agentId);
      if (!fileEntry && selected.some((skill) => skill.validation !== 'valid')) throw new ConflictException('An assigned Skill is invalid.');
      const servers = transaction.select({ id: mcpServers.id, name: mcpServers.name, endpoint: mcpServers.endpoint, authSecret: mcpServers.authSecret, allowedTools: mcpServers.allowedToolNames }).from(agentMcpServers).innerJoin(mcpServers, eq(agentMcpServers.mcpServerId, mcpServers.id)).where(and(eq(agentMcpServers.agentId, agentId), eq(mcpServers.workspaceId, workspaceId))).all();
      return {
        revision: 1,
        agent: { id: agent.id, providerId: agent.providerId, model: agent.providerId ? agent.model : agent.collaboration?.publicModels?.[0] || agent.model, modelParameters: (!agent.providerId ? agent.collaboration?.modelParameters?.[agent.collaboration?.publicModels?.[0] || agent.model] : undefined) ?? agent.modelParameters ?? undefined, systemPrompt: agent.systemPrompt, runtime: agent.runtime, collaboration: agent.collaboration },
        skills: fileEntry?.skills ?? selected.map((skill) => ({ id: skill.id, name: skill.name, instructions: skill.instructions, files: transaction.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(eq(skillFiles.skillId, skill.id)).all() })),
        mcpServers: servers,
      };
    }
    const [agent] = transaction.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId))).limit(1).all();
    const [configuration] = transaction.select().from(chatConfigurations).where(eq(chatConfigurations.workspaceId, workspaceId)).orderBy(desc(chatConfigurations.revision)).limit(1).all();
    if (!agent || !configuration) throw new ConflictException('Chat configuration is unavailable.');
    // Capture the protected platform Skill plus every explicitly selected workspace Skill by value.
    const platformSkillIds = transaction.select({ id: skills.id }).from(skills)
      .where(and(eq(skills.workspaceId, workspaceId), eq(skills.root, 'platform'), eq(skills.directory, WORKLITE_PLATFORM_SKILL_NAME))).all().map((skill) => skill.id);
    const selectedSkillIds = [...new Set([...platformSkillIds, ...configuration.skillIds])];
    const selected = transaction.select({ id: skills.id, name: skills.name, instructions: skills.instructions, validation: skills.validation, validationReason: skills.validationReason }).from(skills)
      .where(and(eq(skills.workspaceId, workspaceId), inArray(skills.id, selectedSkillIds))).all();
    if (selected.length !== selectedSkillIds.length) throw new ConflictException('A selected Chat Skill is no longer available in this workspace.');
    const invalidSkill = selected.find((skill) => skill.validation !== 'valid');
    if (invalidSkill) throw new ConflictException(invalidSkill.validationReason ?? `Chat Skill ${invalidSkill.name} is invalid.`);
    const memories = transaction.select({ id: chatMemories.id, content: chatMemories.content, category: chatMemories.category }).from(chatMemories).where(eq(chatMemories.workspaceId, workspaceId)).orderBy(desc(chatMemories.updatedAt)).all();
    const memoriesPrompt = buildChatMemoriesPrompt(memories);
    return {
      revision: configuration.revision,
      agent: { id: agent.id, providerId: agent.providerId, model: agent.model, runtime: { kind: 'native' as const }, modelParameters: agent.modelParameters ?? undefined, systemPrompt: [
        [agent.systemPrompt, configuration.extensionPrompt].filter(Boolean).join('\n\nUser capability extensions:\n'),
        memoriesPrompt,
      ].filter(Boolean).join('\n\n') },
      skills: selected.map((skill) => ({ id: skill.id, name: skill.name, instructions: skill.instructions, files: transaction.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(eq(skillFiles.skillId, skill.id)).all() })),
      mcpServers: [],
    };
  }

  private async executionMcpRuntimes(request: Request, workspaceSlug: string, execution: typeof agentExecutions.$inferSelect) {
    if (!execution.capabilitySnapshot) return this.resources.agentMcpRuntimes(request, workspaceSlug, execution.agentId);
    return execution.capabilitySnapshot.mcpServers.filter((server) => server.endpoint.trim()).map((server) => ({
      id: server.id, name: server.name, endpoint: server.endpoint,
      ...(server.authSecret ? { authToken: decryptSecret(server.authSecret) } : {}), allowedTools: server.allowedTools,
    }));
  }

  // The retired row may remain solely to preserve its foreign-key-linked history.
  private requireActiveAgent(agentId: string): void {
    if (agentId === 'agt_codex_cli_chat') throw new BadRequestException('Codex CLI Chat has been removed. Use a Codex Agent.');
  }

  private async requireExecutableAgent(workspaceId: string, agentId: string) {
    this.requireActiveAgent(agentId);
    this.requireTopLevelAgent(workspaceId, agentId);
    const catalog = agentFiles(this.db);
    const [agent] = await this.db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId))).limit(1);
    if (!agent) throw new NotFoundException('Agent not found');
    if (agent.kind !== 'custom' && agent.id !== CHAT_AGENT_ID) throw new BadRequestException('This built-in Agent cannot be executed.');
    if ((agentId === CHAT_AGENT_ID || agent.runtime.kind === 'native') && !agent.collaboration?.publicModels?.length && (!agent.providerId || !agent.model)) throw new ConflictException('Configure a model provider and model before running this Agent.');
    const fileEntry = catalog?.get(agentId);
    if (fileEntry) return { agent, assignedSkills: fileEntry.skills };
    const rows = await this.db.select({ id: skills.id, name: skills.name, instructions: skills.instructions, validation: skills.validation, validationReason: skills.validationReason }).from(agentSkills).innerJoin(skills, eq(agentSkills.skillId, skills.id)).where(and(eq(agentSkills.agentId, agentId), eq(skills.workspaceId, workspaceId)));
    const invalidSkill = rows.find((skill) => skill.validation !== 'valid');
    if (invalidSkill) throw new ConflictException(invalidSkill.validationReason ?? `Assigned Skill ${invalidSkill.name} is invalid.`);
    const files = rows.length === 0 ? [] : await this.db.select().from(skillFiles).where(inArray(skillFiles.skillId, rows.map((skill) => skill.id)));
    return { agent, assignedSkills: rows.map((skill) => ({ id: skill.id, name: skill.name, instructions: skill.instructions, files: files.filter((file) => file.skillId === skill.id).map(({ path, content }) => ({ path, content })) })) };
  }

  private requireTopLevelAgent(workspaceId: string, agentId: string): void {
    const catalog = agentFiles(this.db);
    catalog?.refresh(workspaceId);
    const row = this.db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId))).get();
    if (!row) throw new NotFoundException('Agent not found');
    if (row.kind !== 'custom') return;
    const privateIds = new Set(this.db.select().from(agents).where(eq(agents.workspaceId, workspaceId)).all().flatMap((agent) => agent.collaboration?.subAgentIds ?? []));
    if (catalog ? catalog.get(agentId)?.parentId !== null : privateIds.has(agentId)) throw new NotFoundException('Only top-level Agents can be executed directly.');
  }

  async steerRuntimeSession(request: Request, workspaceSlug: string, agentId: string, executionId: string, input: ContinueAgentExecutionRequest): Promise<{ delivered: boolean; queued?: boolean }> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const execution = await this.loadExecution(workspace.id, agentId, executionId);
    if (execution.status !== 'running') throw new ConflictException('Only a running Agent turn accepts steering.');
    const text = normalizeUserMessage(input?.message);
    if (agentId === CHAT_AGENT_ID) {
      await this.queueMessage(request, workspaceSlug, agentId, executionId, { ...input, mode: 'steering' });
      return { delivered: false, queued: true };
    }
    const delivered = await this.agentRuntime.steer(workspace.id, executionId, text);
    if (delivered) {
      // Delivery can race the final result, so append to the current conversation value atomically.
      this.db.transaction((transaction) => {
        transaction.update(agentExecutions).set(executionUpdates(executionId, { displayMessages: appendExecutionMessages(executionId, 'display', [{ id: `msg_${randomUUID()}`, role: 'user', content: text, createdAt: new Date().toISOString() }]), updatedAt: new Date() })).where(eq(agentExecutions.id, executionId)).run();
      });
      await this.publishSnapshotForExecution(workspace.id, executionId);
    }
    return { delivered };
  }

  async closeRuntimeSession(request: Request, workspaceSlug: string, agentId: string, executionId: string): Promise<void> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.loadExecution(workspace.id, agentId, executionId);
    await this.agentRuntime.closeSession(workspace.id, executionId);
  }

  private async advanceCollaboration(workspaceId: string, execution: typeof agentExecutions.$inferSelect): Promise<AgentExecutionView> {
    const controller = new AbortController();
    this.activeModelRequests.set(execution.id, controller);
    const messageId = `msg_${randomUUID()}`;
    let partialText = '';
    try {
      const ready = await this.loadExecution(workspaceId, execution.agentId, execution.id);
      if (ready.status !== 'running') return this.toView(ready);
      controller.signal.throwIfAborted();
      const binding = this.db.select().from(auditLogs).where(and(eq(auditLogs.action, 'chat_agent.dispatched'), eq(auditLogs.resource, execution.id), eq(auditLogs.workspaceId, workspaceId))).get();
      const savedRoot = execution.capabilitySnapshot?.agent.runtime && execution.capabilitySnapshot.agent.runtime.kind !== 'native'
        ? this.db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.action, 'agent.invocation'), eq(auditLogs.resource, execution.id), eq(auditLogs.workspaceId, workspaceId), sql`json_extract(${auditLogs.metadata}, '$.parentRunId') is null`, sql`json_extract(${auditLogs.metadata}, '$.agentId') = ${execution.agentId}`)).orderBy(desc(auditLogs.createdAt)).get()
        : undefined;
      const invocationId = asRecord(binding?.metadata)?.invocationId ?? savedRoot?.id;
      const text = await this.collaboration!.run(workspaceId, execution.id, execution.agentId, { conversation: execution.displayMessages }, controller.signal, (delta) => { partialText += delta; return this.persistEvent(execution.id, { kind: 'message_delta', messageId, delta }); }, execution.projectDirectory ?? undefined, undefined, typeof invocationId === 'string' ? invocationId : undefined);
      controller.signal.throwIfAborted();
      const message = { id: messageId, role: 'assistant' as const, content: text, createdAt: new Date().toISOString() };
      const checkpoint = (await this.loadExecution(workspaceId, execution.agentId, execution.id)).modelMessages;
      const messages = checkpoint.at(-1)?.role === 'assistant' ? checkpoint : [...checkpoint, { role: 'assistant' as const, content: [{ type: 'text' as const, text }] }];
      await this.db.update(agentExecutions).set(executionUpdates(execution.id, { status: 'completed', phase: 'model', error: null, errorCode: null, displayMessages: appendExecutionMessages(execution.id, 'display', [message]), modelMessages: messages, updatedAt: new Date() })).where(and(eq(agentExecutions.id, execution.id), eq(agentExecutions.status, 'running')));
    } catch (error) {
      if (controller.signal.aborted && partialText) this.retainInterruptedReply(execution.id, messageId, partialText);
      if (!controller.signal.aborted) await this.markExecutionFailed(workspaceId, execution.id, executionFailure(error));
    } finally {
      if (this.activeModelRequests.get(execution.id) === controller) this.activeModelRequests.delete(execution.id);
      await this.publishSnapshotForExecution(workspaceId, execution.id);
    }
    return this.toView(await this.loadExecution(workspaceId, execution.agentId, execution.id));
  }

  private async advanceRuntime(request: Request, workspaceSlug: string, workspaceId: string, execution: typeof agentExecutions.$inferSelect): Promise<AgentExecutionView> {
    const snapshot = execution.capabilitySnapshot;
    if (!snapshot?.agent.runtime || snapshot.agent.runtime.kind === 'native') throw new ConflictException('Agent runtime snapshot is unavailable.');
    if (execution.agentId === CHAT_AGENT_ID) throw new ConflictException('Chat only supports the native runtime.');
    const configuration = await validateAgentRuntime({ ...snapshot.agent.runtime, projectDirectory: execution.projectDirectory || snapshot.agent.runtime.projectDirectory });
    if (configuration.kind === 'native') throw new ConflictException('A native Agent cannot enter an external runtime.');
    if (!configuration.projectDirectory) throw new BadRequestException('runtime.projectDirectory is required for this Agent; configure it or pass projectDirectory to run_agent.');
    const existing = this.db.select().from(agentRuntimeSessions).where(and(eq(agentRuntimeSessions.id, execution.id), eq(agentRuntimeSessions.workspaceId, workspaceId))).get();
    let model = existing ? existing.launch.model : snapshot.agent.model || null;
    if (!existing && snapshot.agent.providerId) {
      const runtime = await this.resources.providerRuntime(request, workspaceSlug, snapshot.agent.providerId, snapshot.agent.model);
      model = `${runtime.provider.gatewayProviderName}/${runtime.model}`;
    }
    const input = [...execution.modelMessages].reverse().find((message) => message.role === 'user');
    if (!input || input.role !== 'user') throw new ConflictException('An Agent runtime turn requires user input.');
    // Several directions can be accepted before the engine starts another turn. Preserve those
    // user messages as context even when an intervening scheduled turn was stopped before send.
    let pendingStart = execution.modelMessages.length - 1;
    while (pendingStart > 0 && execution.modelMessages[pendingStart - 1]?.role === 'user') pendingStart--;
    const pendingDirections = execution.modelMessages.slice(pendingStart, -1);
    const runtimeInput = existing?.externalSessionId && pendingDirections.length
      ? `Earlier user directions (context only; do not replay completed operations):\n${JSON.stringify(pendingDirections)}\n\nCurrent user message:\n${input.content}`
      : input.content;
    const controller = new AbortController();
    this.activeModelRequests.set(execution.id, controller);
    const messageId = `msg_${randomUUID()}`;
    let partialText = '';
    try {
      // Recheck after async setup: cancellation may already have settled the conversation.
      const ready = await this.loadExecution(workspaceId, execution.agentId, execution.id);
      if (ready.status !== 'running') return this.toView(ready);
      const output = await this.agentRuntime.executeTurn({
        sessionId: execution.id, runtime: configuration.kind, messageId, approvalPolicy: configuration.approvalPolicy, workspaceId, model, modelParameters: snapshot.agent.modelParameters,
        projectDirectory: configuration.projectDirectory, systemPrompt: snapshot.agent.systemPrompt,
        input: !existing?.externalSessionId && execution.modelMessages.length > 1 ? `Conversation history (context only; do not replay past operations):\n${JSON.stringify(execution.modelMessages.slice(0, -1))}\n\nCurrent user message:\n${input.content}` : runtimeInput, skills: snapshot.skills,
        mcpServers: await this.executionMcpRuntimes(request, workspaceSlug, execution),
        signal: controller.signal, correlation: { surface: 'agent', agentRunId: execution.id, agentExecutionId: execution.id },
        onTextDelta: (delta) => {
          partialText += delta;
          return this.persistEvent(execution.id, { kind: 'message_delta', messageId, delta });
        },
        onInteraction: async (id, question, details) => {
          controller.signal.throwIfAborted();
          const updated = this.db.update(agentExecutions).set({ status: 'waiting_for_input', pendingQuestion: { id, runtimeInteractionId: id, question, options: [], ...details, createdAt: new Date().toISOString() }, updatedAt: new Date() }).where(and(eq(agentExecutions.id, execution.id), eq(agentExecutions.status, 'running'))).run();
          if (!updated.changes) throw new ConflictException('The Agent turn is no longer running.');
          await this.publishSnapshotForExecution(workspaceId, execution.id);
        },
      });
      if (!output.trim()) throw new Error('The Agent runtime returned no reply.');
      this.db.transaction((transaction) => {
        transaction.update(agentExecutions).set(executionUpdates(execution.id, { status: 'completed', pendingQuestion: null, error: null, errorCode: null,
          modelMessages: appendExecutionMessages(execution.id, 'model', [{ role: 'assistant', content: [{ type: 'text', text: output }] }]),
          displayMessages: appendExecutionMessages(execution.id, 'display', [{ id: messageId, role: 'assistant', content: output, createdAt: new Date().toISOString() }]), updatedAt: new Date(),
        })).where(and(eq(agentExecutions.id, execution.id), eq(agentExecutions.status, 'running'))).run();
      });
      await this.publishSnapshotForExecution(workspaceId, execution.id);
      return this.toView(await this.loadExecution(workspaceId, execution.agentId, execution.id));
    } catch (error) {
      if (controller.signal.aborted && partialText) {
        this.retainInterruptedReply(execution.id, messageId, partialText);
      }
      const failure = executionFailure(error);
      const message = error instanceof Error ? error.message : failure.message;
      this.db.update(agentExecutions).set({ status: 'failed', errorCode: failure.code, error: `${message} Inspect prior effects and send a new message to continue; this turn was not replayed.`, pendingQuestion: null, updatedAt: new Date() }).where(and(eq(agentExecutions.id, execution.id), inArray(agentExecutions.status, ['running', 'waiting_for_input']))).run();
      await this.publishSnapshotForExecution(workspaceId, execution.id);
      throw error;
    } finally {
      this.activeModelRequests.delete(execution.id);
    }
  }

  private retainInterruptedReply(executionId: string, messageId: string, text: string): void {
    this.db.update(agentExecutions).set(executionUpdates(executionId, {
      displayMessages: appendExecutionMessages(executionId, 'display', [{ id: messageId, role: 'assistant', content: text, createdAt: new Date().toISOString() }]),
      modelMessages: appendExecutionMessages(executionId, 'model', [{ role: 'assistant', content: [{ type: 'text', text }] }]), updatedAt: new Date(),
    })).where(eq(agentExecutions.id, executionId)).run();
  }

  private async requireSkillAssignment(workspaceId: string, agentId: string, skillId: string | null): Promise<void> {
    if (!skillId) throw new ConflictException('The Skill script request has no Skill assignment.');
    const [assignment] = await this.db.select({ id: skills.id }).from(agentSkills).innerJoin(skills, eq(agentSkills.skillId, skills.id)).where(and(eq(agentSkills.agentId, agentId), eq(skills.workspaceId, workspaceId), eq(skills.id, skillId))).limit(1);
    if (!assignment) throw new ConflictException('This Agent no longer has the requested Skill.');
  }

  private async loadExecution(workspaceId: string, agentId: string, executionId: string) {
    const [execution] = await this.db.select(agentExecutionColumns).from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.agentId, agentId), eq(agentExecutions.workspaceId, workspaceId))).limit(1);
    if (!execution) throw new NotFoundException('Agent execution not found');
    return execution;
  }

  // The execution view never reads modelMessages or capabilitySnapshot, and those columns hold the
  // largest JSON payloads on the row, so read paths that only build a view skip parsing them.
  private async loadExecutionView(workspaceId: string, agentId: string, executionId: string): Promise<AgentExecutionViewRow> {
    const [execution] = await this.db.select(agentExecutionViewColumns).from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.agentId, agentId), eq(agentExecutions.workspaceId, workspaceId))).limit(1);
    if (!execution) throw new NotFoundException('Agent execution not found');
    return execution;
  }

  private async toView(execution: AgentExecutionViewRow): Promise<AgentExecutionView> {
    const calls = await this.db.select().from(agentToolCalls).where(eq(agentToolCalls.executionId, execution.id)).orderBy(agentToolCalls.createdAt);
    const projectTasks = new Map(this.projectTasks.list(execution.id).map((task) => [task.id, task]));
    const invocationRows = await this.db.select({ id: auditLogs.id, metadata: auditLogs.metadata }).from(auditLogs).where(and(eq(auditLogs.workspaceId, execution.workspaceId), eq(auditLogs.action, 'agent.invocation'), eq(auditLogs.resource, execution.id))).orderBy(auditLogs.createdAt, auditLogs.id);
    const agentNames = await this.db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.workspaceId, execution.workspaceId));
    const backgroundIds = [...new Set(calls.flatMap((call) => {
      const id = asRecord(call.input)?.__backgroundExecutionId;
      return call.mcpToolName === 'run_agent' && typeof id === 'string' ? [id] : [];
    }))];
    const backgroundExecutions = backgroundIds.length ? await this.db.select({ id: agentExecutions.id, status: agentExecutions.status, phase: agentExecutions.phase }).from(agentExecutions).where(and(eq(agentExecutions.workspaceId, execution.workspaceId), inArray(agentExecutions.id, backgroundIds))) : [];
    const invocations = agentInvocationDisplays(calls, invocationRows, agentNames, backgroundExecutions, execution.status);
    const conversationStatus = execution.agentId === CHAT_AGENT_ID
      ? chatConversationStatus(execution.status, (await activeChatBackgroundExecutionIds(this.db, execution.workspaceId, [execution.id])).has(execution.id))
      : undefined;
    return { queuedMessages: execution.queuedMessages, executionAuthorization: execution.executionAuthorization ?? null, id: execution.id, agentId: execution.agentId, status: execution.status, ...(conversationStatus ? { conversationStatus } : {}), phase: execution.phase, errorCode: execution.errorCode, messages: execution.displayMessages, toolCalls: calls.filter((call) => execution.agentId !== CHAT_AGENT_ID || !['run_sub_agent', 'run_sub_agents', 'use_capability'].includes(call.mcpToolName ?? '')).map((call) => ({ ...toToolCallView(call), ...(invocations.has(call.id) ? { agentInvocation: invocations.get(call.id) } : {}), ...(call.toolName === 'builtin' && call.mcpToolName === 'project_task' ? { projectTask: projectTasks.get(call.id) } : {}) })), error: execution.error, plan: execution.plan ?? [], pendingQuestion: execution.pendingQuestion ?? null, contextDropped: execution.contextDropped ?? 0, ...(executionUsageView(execution.usage) ? { usage: executionUsageView(execution.usage) } : {}), createdAt: execution.createdAt.toISOString(), updatedAt: execution.updatedAt.toISOString() };
  }

  private async failBackgroundExecution(workspaceId: string, executionId: string, error: unknown): Promise<void> {
    try {
      await this.markExecutionFailed(workspaceId, executionId, executionFailure(error));
    } catch (persistenceError) {
      this.logger.error(`Agent execution ${executionId} failed (${error instanceof Error ? error.message : String(error)}); failure persistence also failed: ${persistenceError instanceof Error ? persistenceError.stack : String(persistenceError)}`);
    }
  }

  private async markExecutionFailed(workspaceId: string, executionId: string, failure: ExecutionFailure): Promise<void> {
    const now = new Date();
    this.db.transaction((transaction) => {
      const updated = transaction.update(agentExecutions).set({ status: 'failed', phase: failure.phase, errorCode: failure.code, error: failure.message, updatedAt: now }).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.status, 'running'))).run();
      if (updated.changes === 0) return;
      for (const call of transaction.select().from(agentToolCalls).where(and(eq(agentToolCalls.executionId, executionId), eq(agentToolCalls.status, 'running'))).all()) {
        if (!isProtectedPlatformSkillId(workspaceId, call.skillId)) continue;
        const diagnostic = platformFailure('execution', 'PLATFORM_EXECUTION_INTERRUPTED', 'unknown', { evidence: { executionErrorCode: failure.code } });
        transaction.update(agentToolCalls).set({ status: 'failed', output: JSON.stringify({ failure: diagnostic }), finishedAt: now }).where(eq(agentToolCalls.id, call.id)).run();
        transaction.insert(auditLogs).values(platformFailureAudit(call, diagnostic)).onConflictDoNothing().run();
      }
      transaction.update(agentSubSessions).set({ unread: true, updatedAt: now }).where(eq(agentSubSessions.executionId, executionId)).run();
      transaction.insert(auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId, action: 'agent_execution.failed', resource: executionId, metadata: { executionId, phase: failure.phase, errorCode: failure.code } }).run();
    });
    await this.publishSnapshotForExecution(workspaceId, executionId);
  }

  async publishSnapshotForExecution(workspaceId: string, executionId: string): Promise<void> {
    const [execution] = await this.db.select(agentExecutionViewColumns).from(agentExecutions).where(and(eq(agentExecutions.id, executionId), eq(agentExecutions.workspaceId, workspaceId))).limit(1);
    if (!execution) return;
    const view = await this.toView(execution);
    const status: AgentExecutionEventData = { kind: 'status', status: view.status, ...(view.conversationStatus ? { conversationStatus: view.conversationStatus } : {}), phase: view.phase, errorCode: view.errorCode, error: view.error };
    const [latestStatus] = await this.db.select({ data: agentExecutionEvents.data }).from(agentExecutionEvents)
      .where(and(eq(agentExecutionEvents.executionId, executionId), eq(agentExecutionEvents.kind, 'status')))
      .orderBy(desc(agentExecutionEvents.sequence)).limit(1);
    // Heartbeat snapshots repeat the same status; persist only actual changes.
    if (JSON.stringify(latestStatus?.data) !== JSON.stringify(status)) {
      await this.persistEvent(executionId, status);
      if (['completed', 'failed', 'cancelled'].includes(view.status)) await this.persistEvent(executionId, { kind: 'native_activity', phase: 'run_end', status: view.status });
    }
    await this.persistEvent(executionId, { kind: 'snapshot', execution: view });
    this.notifyChatTurnSettled(workspaceId, view);
    if (['completed', 'failed', 'cancelled', 'waiting_for_input'].includes(view.status)) this.scheduleBackgroundAgentReports(workspaceId, executionId);
    // Refresh aggregate state when an independent Agent settles, waits or resumes,
    // without waking the Chat model or changing its turn status.
    if (execution.agentId !== CHAT_AGENT_ID) {
      const bindings = await this.db.select({ metadata: auditLogs.metadata }).from(auditLogs)
        .where(and(eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.action, 'chat_agent.dispatched'), eq(auditLogs.resource, executionId)));
      const conversationIds = new Set(bindings.map((binding) => asRecord(binding.metadata)?.conversationId).filter((id): id is string => typeof id === 'string' && id !== executionId));
      for (const id of conversationIds) {
        const [conversation] = await this.db.select({ id: agentExecutions.id }).from(agentExecutions)
          .where(and(eq(agentExecutions.workspaceId, workspaceId), eq(agentExecutions.id, id), eq(agentExecutions.agentId, CHAT_AGENT_ID))).limit(1);
        if (conversation) await this.publishSnapshotForExecution(workspaceId, id);
      }
    }
  }

  // Every Chat turn terminal state — a completed reply, a failure and a pending question — lands here,
  // because each one publishes its snapshot through publishSnapshotForExecution. Hooking the single
  // funnel keeps one notification path instead of one per terminal branch. A cancelled turn stays
  // silent: the user is the one who cancelled it.
  private notifyChatTurnSettled(workspaceId: string, view: AgentExecutionView): void {
    if (view.agentId !== CHAT_AGENT_ID) return;
    const settled = view.status === 'completed' || view.status === 'failed' || view.status === 'waiting_for_input' ? view.status : null;
    if (!settled) {
      this.notifiedTurnStates.delete(view.id);
      return;
    }
    // A periodic [活跃工作进展提醒] reply is server-initiated and recurs while background work runs;
    // it is progress noise, not a conversation state the user has to come back to.
    if (settled === 'completed' && view.messages.at(-1)?.progressReport) return;
    if (this.notifiedTurnStates.get(view.id) === settled) return;
    if (this.notifiedTurnStates.size >= MAX_TRACKED_NOTIFIED_TURNS) {
      const oldest = this.notifiedTurnStates.keys().next();
      if (!oldest.done) this.notifiedTurnStates.delete(oldest.value);
    }
    this.notifiedTurnStates.set(view.id, settled);
    // Detached on purpose: reading the configuration and posting the notification must never delay
    // or fail the turn that settled.
    void (async () => {
      const [configuration] = await this.db.select({ enabled: chatConfigurations.turnNotificationsEnabled, sound: chatConfigurations.turnNotificationSound })
        .from(chatConfigurations).where(eq(chatConfigurations.workspaceId, workspaceId)).orderBy(desc(chatConfigurations.revision)).limit(1);
      if (configuration && !configuration.enabled) return;
      this.hostNotifications.notify({
        title: CHAT_TURN_NOTIFICATION_TITLE,
        subtitle: CHAT_TURN_NOTIFICATION_SUBTITLES[settled],
        body: chatTurnNotificationBody(view, settled),
        sound: configuration?.sound ?? CHAT_TURN_NOTIFICATION_DEFAULT_SOUND,
      });
    })().catch((error) => {
      this.logger.warn(`Chat turn notification for ${view.id} was not sent: ${error instanceof Error ? error.message : 'unknown error'}.`);
    });
  }

  private async persistEvent(executionId: string, data: AgentExecutionEventData): Promise<void> {
    if (data.kind === 'message_delta') {
      let batch = this.textBatches.get(executionId);
      if (!batch) {
        batch = new StreamBatch(
          (value) => this.writeEvent(executionId, value),
          (left, right) => {
            const { delta: _left, ...a } = left;
            const { delta: _right, ...b } = right;
            return JSON.stringify(a) === JSON.stringify(b) ? { ...left, delta: left.delta + right.delta } : undefined;
          },
          (value) => Buffer.byteLength(value.delta),
        );
        this.textBatches.set(executionId, batch);
      }
      batch.push(data);
      return;
    }
    const batch = this.textBatches.get(executionId);
    if (batch) { await batch.flush(); if (this.textBatches.get(executionId) === batch) this.textBatches.delete(executionId); }
    await this.writeEvent(executionId, data);
  }

  private async writeEvent(executionId: string, data: AgentExecutionEventData): Promise<void> {
    const previous = this.eventQueues.get(executionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      // A snapshot is a complete execution view, so it supersedes every earlier one.
      // The new row is allocated first so that deleting a trailing snapshot never
      // lets a later event reuse its sequence.
      // Reserve the writer before reading: WAL read-to-write promotion can fail with
      // SQLITE_BUSY_SNAPSHOT if maintenance commits meanwhile, bypassing busy_timeout.
      const row = this.db.transaction((transaction) => {
        if (data.kind === 'snapshot') {
          const previous = transaction.select({ data: agentExecutionEvents.data }).from(agentExecutionEvents).where(and(eq(agentExecutionEvents.executionId, executionId), eq(agentExecutionEvents.kind, 'snapshot'))).orderBy(desc(agentExecutionEvents.sequence)).get();
          if (JSON.stringify(previous?.data) === JSON.stringify(data)) return undefined;
        }
        const inserted = transaction.insert(agentExecutionEvents).values({
          executionId,
          kind: data.kind,
          sequence: sql<number>`coalesce((select max(sequence) from agent_execution_events where execution_id = ${executionId}), 0) + 1`,
          data,
        }).returning().get();
        if (inserted && data.kind === 'native_activity' && data.phase === 'tool_progress') {
          transaction.delete(agentExecutionEvents).where(and(eq(agentExecutionEvents.executionId, executionId), lt(agentExecutionEvents.sequence, inserted.sequence),
            sql`json_extract(${agentExecutionEvents.data}, '$.kind') = 'native_activity'`, sql`json_extract(${agentExecutionEvents.data}, '$.phase') = 'tool_progress'`,
            sql`json_extract(${agentExecutionEvents.data}, '$.toolCallId') = ${data.toolCallId}`)).run();
        }
        if (inserted && data.kind === 'snapshot') {
          transaction.delete(agentExecutionEvents).where(and(
            eq(agentExecutionEvents.executionId, executionId),
            lt(agentExecutionEvents.sequence, inserted.sequence),
            eq(agentExecutionEvents.kind, 'snapshot'),
          )).run();
        }
        return inserted;
      }, { behavior: 'immediate' });
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

function shortDispatchText(value: string, limit: number): string {
  const plain = value.replace(/!?\[([^\]\n]*)\]\([^\n)]*\)/g, '$1')
    .replace(/[*`#~|]/g, '').replace(/[<>]/g, (char) => char === '<' ? '＜' : '＞')
    .replace(/[\p{Cc}\p{Z}\s]+/gu, ' ').trim();
  const characters = Array.from(plain);
  return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : plain;
}

function normalizeUserMessage(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw new BadRequestException('An Agent message is required.');
  return input.trim();
}

// Compacting history is mechanical summarization, not a task that benefits from deep thinking;
// a reasoning model given no explicit effort can spend its entire output budget thinking and
// leave zero room for the summary itself (observed on a GLM model: 4096/4096 tokens of reasoning,
// an empty reply, finishReason 'length'). The agent's own serviceTier and requestBody still apply;
// only reasoningEffort is capped to the lowest value each protocol actually accepts
// (modelRequestParameters rejects 'none'/'minimal' for Anthropic).
function compactionModelParameters(agentModelParameters: ModelParameters | null | undefined, protocol: ModelProviderProtocol): ModelParameters {
  const base = agentModelParameters ?? {};
  const lowest = protocol === 'anthropic/messages' ? 'low' : 'minimal';
  const accepted = protocol === 'anthropic/messages' ? ['low'] : ['none', 'minimal', 'low'];
  if (base.reasoningEffort && accepted.includes(base.reasoningEffort)) return base;
  return { ...base, reasoningEffort: lowest };
}

// Short context for a host notification: the pending question, the failure reason, or the reply the
// turn produced, falling back to the request it answered. The sender truncates and escapes it.
export function chatTurnNotificationBody(view: Pick<AgentExecutionView, 'messages' | 'pendingQuestion' | 'error' | 'errorCode'>, settled: 'completed' | 'failed' | 'waiting_for_input'): string {
  if (settled === 'waiting_for_input') return view.pendingQuestion?.question?.trim() || 'Chat 正在等待你的回答。';
  if (settled === 'failed') return view.error?.trim() || view.errorCode?.trim() || 'Chat 对话执行失败。';
  const spoken = view.messages.filter((message) => message.kind !== 'summary_divider' && message.content.trim());
  const latest = [...spoken].reverse().find((message) => message.role === 'assistant') ?? spoken.at(-1);
  return latest?.content.trim() || 'Chat 已完成这一轮对话。';
}

// capture() can reject with any exception the executor launch or Gateway model resolution raises,
// including NotFoundException/ServiceUnavailableException from resolving the executor's declared
// model against the Gateway's registered Providers; only an unrecognized error type falls back to
// the generic message, so a real, actionable cause (missing Gateway Provider, unreachable Gateway,
// invalid executor plugin command, etc.) is never silently replaced.
export function projectTaskCaptureFailureMessage(error: unknown): string {
  return error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException || error instanceof ServiceUnavailableException || error instanceof ClaudeCodeError || error instanceof CodexAppServerError
    ? error.message
    : '无法启动项目任务，请检查项目目录、内置执行器可用性和 Gateway 模型。';
}

// Chat's steer_project_task result: the newest steer entry tells whether the live Codex turn took
// the instruction or it waits for the follow-up round at the current round's end.
export function projectTaskSteerOutput(task: Pick<ChatProjectTaskView, 'id' | 'executor' | 'steerQueue'>): string {
  const instruction = task.steerQueue.at(-1);
  const label = instruction?.seq ? `补充指令 #${instruction.seq}` : '补充指令';
  return instruction?.status === 'delivered'
    ? `${label}已送达正在运行的 Codex 当前轮次（taskId: ${task.id}，状态: delivered）。任务继续运行，结束时会自动汇报。`
    : `${label}已排队（taskId: ${task.id}，状态: queued）：${task.executor === 'claude' ? 'Claude Code 无法在执行中途接收输入，' : '当前轮次暂时无法接收，'}将在当前轮次结束后由后续轮次作为 userCorrections 应用。任务继续运行，结束时会自动汇报。`;
}

function normalizeAssistantMessage(input: string): string {
  const trimmed = input.trim();
  return /^\\+$/.test(trimmed) ? '' : input;
}

function toolCallOutput(call: typeof agentToolCalls.$inferSelect, workspaceId: string): GatewayToolResultOutput {
  const output = call.output || '(no output)';
  const header = `status=${call.status}\nexitCode=${call.exitCode ?? 'none'}\n\n`;
  const marker = '\n\n[Output limited to 60000 characters for Chat context; full output remains in the execution record.]';
  const boundedOutput = (call.toolName === 'skill_script' || (call.toolName === 'builtin' && call.mcpToolName === 'run_host_command')) && header.length + output.length > 60_000
    ? `${output.slice(0, Math.max(0, 60_000 - header.length - marker.length))}${marker}`
    : output;
  const expectedInput = call.status === 'failed' && isProtectedPlatformSkillId(workspaceId, call.skillId) && call.scriptPath
    ? platformToolManifest(call.packageFiles)[call.scriptPath]?.inputSchema
    : undefined;
  const details = `${header}${boundedOutput}${expectedInput ? `\n\nExpected input for this tool (correct the request against it before retrying):\n${JSON.stringify(expectedInput)}` : ''}`;
  return call.status === 'completed' ? { type: 'text', value: details } : { type: 'error-text', value: details };
}

function protectedPlatformSkillIds(workspaceId: string): string[] {
  // Existing immutable capability snapshots keep the pre-local core ID.
  return [localSkillId(workspaceId, skillDirectoryName(WORKLITE_PLATFORM_SKILL_NAME), 'platform'), 'sk_worklite_platform'];
}

function isProtectedPlatformSkillId(workspaceId: string, skillId: string | null | undefined): boolean {
  return skillId != null && protectedPlatformSkillIds(workspaceId).includes(skillId);
}

function diagnosticModelMessages(messages: readonly StoredAgentModelMessage[], calls: readonly (typeof agentToolCalls.$inferSelect)[]): GatewayAgentMessage[] {
  const references = new Map<string, GatewayToolResultOutput>();
  for (const call of calls) {
    let data: Record<string, unknown> | null;
    try { data = asRecord(asRecord(JSON.parse(call.output))?.data); } catch { continue; }
    if (!data || data.recordSelection || !Array.isArray(data.events) || !data.events.some((event: unknown) => asRecord(asRecord(event)?.data)?.kind === 'snapshot')) continue;
    references.set(call.toolCallId, { type: 'text', value: JSON.stringify({
      status: call.status, exitCode: call.exitCode,
      note: 'This full conversation log includes repeated replay snapshots. Its original output is retained; inspect the current diagnostic selection instead of loading the complete snapshot history into model context. No command was repeated.',
      conversation: data.conversation,
      outputReference: { tool: 'inspect_chat_conversation', input: { conversationId: call.executionId, toolCallId: call.id }, commandExecutionId: call.commandExecutionId, characters: call.output.length },
      diagnosticReference: { tool: 'inspect_chat_conversation', input: { conversationId: asRecord(data.conversation)?.id, records: true } },
    }) });
  }
  return messages.map((message) => message.role === 'tool' ? { ...message, content: message.content.map((part) => references.has(part.toolCallId) ? { ...part, output: references.get(part.toolCallId)! } : part) } : message);
}

function modelToolName(call: typeof agentToolCalls.$inferSelect): string {
  if (call.toolName === 'builtin') return call.mcpToolName ?? 'builtin';
  if (call.toolName === 'mcp' && call.mcpServerId && call.mcpToolName) return `mcp_${call.mcpServerId}_${call.mcpToolName}`;
  // Script calls store the tool name the model used: a typed platform tool, or skill_script.
  if (call.toolName === 'skill_script') return call.mcpToolName ?? 'skill_script';
  return call.toolName;
}

// The protected platform package keys script tools by script path and runtime tools by a non-script key.
// Runtime-only tools such as run_host_command are never exposed as skill_script calls.
function platformToolManifest(files: ReadonlyArray<{ path: string; content: string }>): Record<string, GatewayToolDefinition> {
  const manifest = files.find((file) => file.path === 'scripts/tools.json');
  return manifest ? JSON.parse(manifest.content) as Record<string, GatewayToolDefinition> : {};
}

export function platformRuntimeTool(files: ReadonlyArray<{ path: string; content: string }>, name: string): GatewayToolDefinition | undefined {
  return Object.entries(platformToolManifest(files)).find(([key, tool]) => !key.startsWith('scripts/') && tool.name === name)?.[1];
}

// These are the existing agent_tool_calls evidence columns. The bounded output text retains duration,
// timeout flags and both stream tails; arguments retains the complete shell command.
export function hostCommandToolCallUpdate(result: ChatHostCommandResult) {
  return {
    workingDirectory: result.cwd,
    arguments: result.argv,
    status: result.status,
    output: result.output,
    exitCode: result.exitCode,
  };
}

function shellRecoveryQuestion(call: typeof agentToolCalls.$inferSelect): AgentPendingQuestion {
  return { id: `question_${randomUUID()}`, shellCallId: call.id, question: '此 Shell 调用已中断，执行效果需要确认。可以采用已有命令的确定结果，或标记本次调用失败；命令不会自动重跑。', options: [], recovery: { operationKey: call.id, ...(call.commandExecutionId ? { commandExecutionId: call.commandExecutionId } : {}) }, createdAt: new Date().toISOString() };
}

// A Chat question is shown as an exchange rather than a script row. Only a completed ordinary
// question carries an answer: cancellation and an accepted new conversation also settle the call.
function toQuestionView(call: typeof agentToolCalls.$inferSelect): AgentToolCallView['question'] {
  if (call.toolName !== 'builtin' || call.mcpToolName !== 'ask_user') return undefined;
  const record = asRecord(call.input);
  const text = typeof record?.question === 'string' ? record.question.trim() : '';
  if (!text) return undefined;
  return { text, answer: call.status === 'completed' && record?.action !== 'new_conversation' ? call.output : null };
}

function toToolCallView(call: typeof agentToolCalls.$inferSelect): AgentToolCallView {
  const question = toQuestionView(call);
  return { ...(call.shell ? { shell: call.shell } : {}), ...(question ? { question } : {}), id: call.id, workingDirectory: call.workingDirectory, skillId: call.skillId, skillName: call.skillName, scriptPath: call.scriptPath, mcpServerId: call.mcpServerId, mcpToolName: call.mcpToolName, arguments: call.arguments, status: call.status, output: call.output, exitCode: call.exitCode, commandExecutionId: call.commandExecutionId, result: call.result, createdAt: call.createdAt.toISOString(), finishedAt: call.finishedAt?.toISOString() ?? null };
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

function platformFailureAudit(call: typeof agentToolCalls.$inferSelect, failure: PlatformFailure) {
  return { id: `failure_${call.id}`, workspaceId: call.workspaceId, action: 'platform.tool_failure', resource: call.id, metadata: { executionId: call.executionId, toolCallId: call.toolCallId, skillId: call.skillId, scriptPath: call.scriptPath, commandExecutionId: call.commandExecutionId, contractHash: platformContractHash(call.packageFiles), failure } };
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
  if (result.type === 'provider_models') {
    const data = asRecord(wrapper?.data);
    return Object.keys(result).every((key) => key === 'type' || key === 'providerId')
      && typeof result.providerId === 'string' && result.providerId.length > 0 && result.providerId.length <= 240
      && Array.isArray(data?.models) && data.models.every((model) => typeof model === 'string' && model.trim().length > 0)
      && (data.providerId === undefined || data.providerId === result.providerId)
      ? { type: 'snapshot' } : null;
  }
  if (result.type === 'dispatch' && typeof result.submissionId === 'string' && typeof result.route === 'string' && /^\/(coding\/runs|workflows)\/[A-Za-z0-9_-]+$/.test(result.route)) return { type: 'dispatch', submissionId: result.submissionId, route: result.route };
  if (['coders', 'coder', 'coder-records', 'coder-memories', 'coder-memory', 'coder-group', 'coder-document', 'coder-run', 'coder-run-action'].includes(result.type)) return { type: 'snapshot' };
  if (result.type === 'snapshot') return Object.keys(result).length === 1 ? { type: 'snapshot' } : null;
  if (result.type === 'settings') {
    const appearance = result.appearance;
    return appearance === 'system' || appearance === 'light' || appearance === 'dark'
      ? Object.keys(result).length === 2 ? { type: 'settings', appearance } : null
      : null;
  }
  if (result.type === 'navigation') {
    const target = result.target;
    const route = typeof result.route === 'string' ? result.route : '';
    return isWorkliteNavigationTarget(target) && resolveWorkliteNavigationRoute(target) === route ? { type: 'navigation', target, route } : null;
  }
  if (result.type === 'resource') {
    const resourceType = result.resourceType;
    const id = typeof result.id === 'string' && result.id.length > 0 && result.id.length <= 240 ? result.id : null;
    const route = typeof result.route === 'string' ? result.route : '';
    if (!id || (resourceType !== 'provider' && resourceType !== 'skill' && resourceType !== 'mcp-server' && resourceType !== 'workflow')) return null;
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
  if (record?.action !== undefined && record.action !== 'new_conversation') throw new BadRequestException('Unsupported conversation action.');
  return { ...(record?.action ? { action: record.action as 'new_conversation' } : {}), id: `question_${randomUUID()}`, question, options: record?.action === 'new_conversation' ? [] : options, createdAt: new Date().toISOString() };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// The model-only settlement note appended to the owning conversation or to a subscribed one.
// Historical Worktree merge outcomes remain reportable; new executor-managed Git choices are
// summarized by the executor in the task result.
function buildTaskReportNote(task: typeof chatProjectTasks.$inferSelect, subscribed: boolean): string {
  const prefix = subscribed ? '[订阅项目任务提醒]' : '[后台项目任务提醒]';
  const mergeNote = task.mergeStatus === 'merged' ? `改动已自动合并回分支 ${task.baseBranch ?? ''}，任务 worktree 已移除。`
    : task.mergeStatus === 'merged_cleanup_pending' ? `改动已自动合并回分支 ${task.baseBranch ?? ''}；worktree ${task.worktreePath ?? ''} 未能自动清理，请手动删除。`
      : task.mergeStatus === 'conflict' ? ''
        : task.worktreePath ? `任务改动保留在 worktree ${task.worktreePath}（分支 ${task.worktreeBranch ?? ''}）。`
          : '';
  if (task.status === 'waiting_for_input') {
    return `${prefix} 任务 ${task.id}（目录 ${task.projectDirectory}）正在等待用户回答：${task.pendingQuestion?.question ?? ''}（questionId: ${task.pendingQuestion?.id ?? ''}）。${mergeNote}请简要转述该问题，并说明用户可以直接在任务卡片中回答；不要向用户复述本提醒本身。`;
  }
  if (task.status === 'succeeded') {
    return `${prefix} 任务 ${task.id}（目录 ${task.projectDirectory}）已完成。${mergeNote}任务结果摘要：${task.result ?? ''}。请用简短回复向用户汇报该结果；不要向用户复述本提醒本身。`;
  }
  return `${prefix} 任务 ${task.id}（目录 ${task.projectDirectory}）失败。错误：${task.error ?? '未知错误'}。请用简短回复向用户汇报失败原因；不要向用户复述本提醒本身。`;
}
