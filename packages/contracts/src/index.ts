export type RunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'waiting_for_input'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export type NodeErrorPolicy = 'stop' | 'retry';

export type HealthResponse = {
  status: 'ok';
};

export type CommandExecutionStatus = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';

export type CreateCommandRequest = {
  command: string;
};

export type CommandExecutionEvent = {
  sequence: number;
  commandId: string;
  type: 'stdout' | 'stderr' | 'lifecycle';
  data: string;
  createdAt: string;
};

export type CommandExecutionView = {
  id: string;
  command: string;
  cwd: string;
  status: CommandExecutionStatus;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type WorkspaceView = {
  id: string;
  slug: string;
  name: string;
};

export type PluginView = {
  id: 'codex-cli-chat' | 'claude-code' | 'feishu-bot' | 'wechat-bot' | 'wechat-official-account';
  name: string;
  description: string;
  command: string;
  codexConfigPath?: string;
  enabled: boolean;
  status: 'available' | 'missing' | 'failed';
  updatedAt: string;
  feishu?: FeishuConnectionView;
  wechat?: WechatConnectionView;
  officialAccount?: WechatOfficialAccountView;
};

export type WechatOfficialAccountStatus = 'disconnected' | 'qr_pending' | 'connected' | 'error';

export type WechatOfficialAccountView = {
  id: string;
  displayName: string;
  status: WechatOfficialAccountStatus;
  qrCode: string | null;
  qrExpiresAt: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
  updatedAt: string;
};

export type FeishuRegistrationView = {
  id: string;
  status: 'pending' | 'completed' | 'needs_user_id' | 'denied' | 'expired' | 'error' | 'cancelled';
  verificationUrl: string | null;
  expiresAt: string | null;
  error: string | null;
};

export type FeishuConnectionView = {
  appId: string;
  hasAppSecret: boolean;
  allowedUserId: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  lastError: string | null;
  registration: FeishuRegistrationView | null;
};

export type WechatLoginView = {
  id: string;
  status: 'pending' | 'scanned' | 'confirmed' | 'expired' | 'error';
  qrCodeUrl: string | null;
  error: string | null;
};

export type WechatConnectionView = {
  botId: string;
  hasToken: boolean;
  allowedUserId: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  lastError: string | null;
  login: WechatLoginView | null;
};

export type UpdatePluginRequest = {
  command?: string;
  codexConfigPath?: string;
  feishu?: { appId: string; appSecret?: string; allowedUserId: string };
  wechat?: { allowedUserId: string };
};

export type ChatTarget =
  | { kind: 'conversation' }
  // `mode` remains accepted only for older callers. Current dispatch ignores it
  // and the Team Dispatcher chooses the Run mode.
  | { kind: 'team'; teamId: string; projectDirectory: string; role?: AgentTeamRoleId; mode?: 'plan_only' | 'validate_existing' | 'implement_and_validate' }
  | { kind: 'workflow'; workflowId: string };

export type ChatTaskReference =
  | { kind: 'conversation'; executionId: string; afterMessageId: string | null; afterSequence: number; untilMessageId?: string | null; completionStatus?: string; completionError?: string | null }
  | { kind: 'team'; teamId: string; runId: string; groupId?: string }
  | { kind: 'workflow'; runId: string; workflowVersionId: string }
  | { kind: 'upgrade'; jobId: string };

export type DispatchChatRequest = {
  submissionId: string;
  message: string;
  target: ChatTarget;
  executionId?: string | null;
  questionId?: string;
  newConversation?: boolean;
  recoveryDecision?: 'adopt_command' | 'mark_failed';
};

export type DispatchChatResponse = {
  submissionId: string;
  reference: ChatTaskReference;
};

export type WorkliteUpgradeView = {
  id: string;
  releaseHash: string;
  summary: string;
  phase: string;
  error: string | null;
  updatedAt: string;
  interruptionPolicy: 'cancel_active_work_without_resume';
};

export const CHAT_AGENT_ID = 'agt_system_helper_chat';
export const WORKLITE_PLATFORM_SKILL_NAME = 'worklite-platform';

export type ChatChannelView = {
  id: string;
  name: string;
  builtIn: boolean;
  presentation: string[];
};

export type ChatConversationSummary = {
  id: string;
  executionId: string | null;
  title: string;
  channel: string;
  channelConversationId: string | null;
  status: AgentExecutionStatus | 'queued' | 'task';
  createdAt: string;
  updatedAt: string;
};

export type ChatConversationList = {
  items: ChatConversationSummary[];
  nextCursor: string | null;
};

export type ChatConversationView = {
  conversation: ChatConversationSummary;
  execution: AgentExecutionView | null;
  pendingReceipts: Array<{ id: string; text: string; status: 'queued' | 'failed'; error: string | null; createdAt: string }>;
  submissions: ChatSubmissionView[];
  channelDelivery: 'web' | 'connected' | 'disconnected' | 'unbound';
};

export type ChatSubmissionView = {
  id: string;
  origin: string;
  executionId: string | null;
  message: string;
  reference: ChatTaskReference | null;
  outputMessageId: string | null;
  renderedCard: Record<string, unknown> | null;
  renderedTaskCards?: Record<string, Record<string, unknown>> | null;
  settled: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatConversationRecords = {
  conversation: ChatConversationSummary;
  execution: AgentExecutionView | null;
  events: AgentExecutionEvent[];
  receipts: Array<{ id: string; payload: Record<string, unknown>; status: 'queued' | 'done' | 'failed'; error: string | null; createdAt: string }>;
  submissions: ChatSubmissionView[];
  deliveries: Array<{ id: string; messageId: string | null }>;
};

export type SummarizeChatConversationResponse = AgentExecutionView;

// Single source for Chat memory categories and their prompt-injection behavior;
// the API, platform tools and Web management surface all derive from this declaration.
export const CHAT_MEMORY_CATEGORIES = ['rule', 'preference', 'project', 'project_state', 'workflow', 'other'] as const;
export type ChatMemoryCategory = (typeof CHAT_MEMORY_CATEGORIES)[number];
export const CHAT_MEMORY_CATEGORY_META: Record<ChatMemoryCategory, { injection: 'always' | 'on_demand' }> = {
  rule: { injection: 'always' },
  preference: { injection: 'always' },
  project: { injection: 'on_demand' },
  project_state: { injection: 'on_demand' },
  workflow: { injection: 'on_demand' },
  other: { injection: 'on_demand' },
};
export const CHAT_MEMORY_DEFAULT_CATEGORY: ChatMemoryCategory = 'preference';

// macOS system sounds the Chat turn notification may use; the API accepts only these names, and an
// empty selection delivers the notification silently. The Web settings surface offers the same list.
export const CHAT_TURN_NOTIFICATION_SOUNDS: readonly string[] = ['Glass', 'Ping', 'Hero', 'Submarine', 'Blow', 'Bottle', 'Frog', 'Funk', 'Morse', 'Pop', 'Purr', 'Sosumi', 'Tink'];
export const CHAT_TURN_NOTIFICATION_DEFAULT_SOUND = 'Glass';

export type ChatMemoryView = {
  id: string;
  content: string;
  category: ChatMemoryCategory;
  sourceConversationId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatMemoryList = {
  items: ChatMemoryView[];
};

export type SaveChatMemoryRequest = {
  content: string;
  category?: ChatMemoryCategory;
  sourceConversationId?: string;
};

export type UpdateChatMemoryRequest = {
  content?: string;
  category?: ChatMemoryCategory;
};

export type PluginTestResult = {
  enabled: boolean;
  status: 'available' | 'missing' | 'failed';
};

export type AgentView = {
  // Each declared executor default is one model id, or an ordered list of fallback candidates.
  chatConfiguration?: { revision: number; extensionPrompt: string; executorContext: string; summarizePrompt: string; defaultExecutor: ProjectExecutor; defaultExecutorModels: Partial<Record<ProjectExecutor, string | string[]>>; projectTaskMcpServerIds: string[]; turnNotificationsEnabled: boolean; turnNotificationSound: string; skillIds: string[] };
  id: string;
  workspaceSlug: string;
  kind: 'system' | 'custom';
  name: string;
  responsibility: string;
  systemPrompt: string;
  initials: string;
  model: string;
  providerId: string | null;
  providerName: string | null;
  skills: Array<{
    id: string;
    name: string;
    version: string;
    validation: 'valid' | 'invalid' | 'pending';
  }>;
  mcpServers: Array<{
    id: string;
    name: string;
    version: string;
    connection: 'connected' | 'unreachable' | 'auth_failed' | 'unconfigured';
    allowedTools: number;
  }>;
  version: 'draft';
  latestVersionId?: string | null;
  latestVersion?: number | null;
  updatedAt: string;
};

export type AgentVersionView = {
  id: string;
  agentId: string;
  version: number;
  name: string;
  responsibility: string;
  systemPrompt: string;
  providerId: string | null;
  model: string;
  skillIds: string[];
  mcpServerIds: string[];
  createdAt: string;
};

export type AgentExecutionStatus = 'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled';

export type AgentExecutionPhase = 'model' | 'skill' | 'recovery';

export type AgentExecutionErrorCode =
  | 'provider'
  | 'provider_request'
  | 'invalid_request'
  | 'invalid_tool_request'
  | 'incomplete_tool_request'
  | 'missing_tool_results'
  | 'too_many_tool_calls'
  | 'skill'
  | 'mcp'
  | 'restarted'
  | 'internal';

export type ChatProgressReport = {
  // stage/progress/updatedAt are presentation fields for the collapsible Web card; the reminder
  // text and its dedupe signature do not depend on them.
  items: Array<{ kind: 'task' | 'team' | 'workflow'; id: string; title: string; status: string; stage?: string; progress?: string; updatedAt?: string }>;
};

export type AgentExecutionMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  progressReport?: ChatProgressReport;
  // A summary divider marks where a /summarize compressed the model context; it is a
  // transcript marker persisted among the display messages, not a spoken message.
  kind?: 'summary_divider';
};

export type AgentPlanStep = {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
};

export type AgentPendingQuestion = {
  action?: 'new_conversation' | 'confirm_execution';
  projectTaskId?: string;
  shellCallId?: string;
  recovery?: { operationKey: string; commandExecutionId?: string };
  id: string;
  question: string;
  options: string[];
  createdAt: string;
};

export type AgentToolCallStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type ProjectExecutor = 'codex' | 'claude';

export type ProjectExecutorLaunchView =
  | { executor: 'codex'; commandArguments: string[]; model: string | null; configDirectory?: string; modelSource?: 'task' | 'configuration' | 'executor' }
  | { executor: 'claude'; commandArguments: string[]; baseUrl: string; model: string | null; modelSource?: 'task' | 'configuration' | 'executor' };

export type ChatAttachmentView = {
  id: string; fileName: string; mimeType: string; size: number;
  /** Same-origin API path, e.g. /api/chat/attachments/att_…; used as the Markdown image target. */
  url: string;
  markdown: string;
  expiresAt: string;
};

// A user-submitted mid-run correction, an increment on the captured goal rather than a replacement.
// 'delivered' reached the live Codex turn through turn/steer; 'queued' is waiting for the task's
// next round boundary (Claude Code, or a Codex turn that could not accept it); 'consumed' was
// injected into the input of the round that started at that boundary. `seq`, `source`, `consumedAt`
// and `consumedTurn` are absent on instructions recorded before they existed; consumedTurn is the
// 1-based round of the task in which the instruction was applied.
export type ProjectTaskSteerInstruction = {
  id: string;
  seq?: number;
  source?: 'user';
  text: string;
  createdAt: string;
  status: 'delivered' | 'queued' | 'consumed';
  consumedAt?: string;
  consumedTurn?: number;
};

export type SteerProjectTaskRequest = {
  text: string;
};

export type ChatProjectTaskView = {
  executor: ProjectExecutor | null;
  launch?: ProjectExecutorLaunchView;
  id: string; executionId: string; goal: string; projectDirectory: string; model: string;
  status: 'running' | 'waiting_for_input' | 'waiting_for_recovery' | 'succeeded' | 'failed' | 'cancelled';
  stage: 'starting' | 'working' | 'responding' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
  configurationRevision: number; pendingQuestion: AgentPendingQuestion | null;
  activityCount: number; activityPhases: Record<string, number>; activities: Array<Record<string, unknown>>; activitiesTruncated?: boolean; result: string; error: string | null;
  progressText: string;
  // Submitted mid-run corrections, newest last. A steerable task (running, not yet waiting for a
  // question) accepts another; a settled task's queue is read-only evidence.
  steerQueue: ProjectTaskSteerInstruction[];
  operationCount: number; operationStatuses: Record<string, number>;
  operations: Array<{ key: string; toolName: string; status: 'reserved' | 'completed' | 'uncertain' | 'failed'; commandExecutionId: string | null; inputSummary: string | null; failureReason: string | null }>;
  // Historical WorkLite-managed worktree isolation; new project tasks leave these fields empty.
  worktreePath?: string | null; worktreeBranch?: string | null; baseBranch?: string | null; baseCommit?: string | null;
  mergeStatus?: 'not_attempted' | 'merging' | 'merged' | 'merged_cleanup_pending' | 'conflict' | 'skipped_not_git' | 'skipped_read_only'; mergeError?: string | null;
  createdAt: string; updatedAt: string;
};

export type ChatProjectOperationDetailView = {
  taskId: string;
  key: string;
  toolName: string;
  status: 'reserved' | 'completed' | 'uncertain' | 'failed';
  commandExecutionId: string | null;
  result: unknown;
  failureReason: string | null;
};

export type AgentToolCallView = {
  shell?: { command: string; state: 'awaiting_confirmation' | 'authorized' | 'reserved' | 'uncertain' | 'settled'; authorizationId?: string; approvedAt?: string };
  projectTask?: ChatProjectTaskView;
  /** Present only for a Chat `ask_user` call: the stored question and the user's accepted answer, if any. */
  question?: { text: string; answer: string | null };
  id: string;
  workingDirectory: string;
  skillId: string | null;
  skillName: string | null;
  scriptPath: string | null;
  mcpServerId: string | null;
  mcpToolName: string | null;
  arguments: string[];
  status: AgentToolCallStatus;
  output: string;
  exitCode: number | null;
  commandExecutionId: string | null;
  result: WorkliteScriptResult | null;
  createdAt: string;
  finishedAt: string | null;
};

export type ChatExecutionAuthorization = {
  id: string; questionId: string; proposal: string;
  status: 'pending' | 'approved' | 'declined'; approvedAt: string | null; createdAt: string;
};

export type AgentExecutionView = {
  executionAuthorization: ChatExecutionAuthorization | null;
  id: string;
  agentId: string;
  status: AgentExecutionStatus;
  phase: AgentExecutionPhase;
  errorCode: AgentExecutionErrorCode | null;
  messages: AgentExecutionMessage[];
  toolCalls: AgentToolCallView[];
  error: string | null;
  plan: AgentPlanStep[];
  pendingQuestion: AgentPendingQuestion | null;
  contextDropped: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentExecutionEventData =
  | { kind: 'snapshot'; execution: AgentExecutionView }
  | { kind: 'message_delta'; messageId: string; delta: string; progressReport?: ChatProgressReport }
  | { kind: 'status'; status: AgentExecutionStatus; phase: AgentExecutionPhase; errorCode: AgentExecutionErrorCode | null; error: string | null }
  | { kind: 'tool_call'; call: AgentToolCallView };

export type AgentExecutionEvent = {
  sequence: number;
  executionId: string;
  data: AgentExecutionEventData;
  createdAt: string;
};

export type CreateAgentExecutionRequest = {
  message: string;
};

export type ContinueAgentExecutionRequest = {
  message: string;
};

export type AnswerAgentQuestionRequest = {
  recoveryDecision?: 'adopt_command' | 'mark_failed';
  questionId: string;
  answer: string;
};

export type CreateAgentRequest = {
  name: string;
  responsibility: string;
  systemPrompt: string;
  providerId: string | null;
  model: string;
  skillIds: string[];
  mcpServerIds: string[];
};

export type CreateAgentVersionRequest = Record<string, never>;

export type UpdateAgentRequest = Partial<CreateAgentRequest> & {
  providerId?: string | null;
  extensionPrompt?: string;
  // WorkLite-managed persistent context injected into both Codex and Claude Code project tasks.
  executorContext?: string;
  // Custom prompt for /summarize; an omitted key keeps it, an empty string restores the built-in default.
  summarizePrompt?: string;
  defaultExecutor?: ProjectExecutor;
  // Declared default Gateway public model per executor: one model id or an ordered list of
  // fallback candidates sets it, null clears it, an omitted key keeps it.
  defaultExecutorModels?: Partial<Record<ProjectExecutor, string | string[] | null>>;
  // Workspace MCP servers injected into Claude Code project tasks; an omitted key keeps the declaration.
  projectTaskMcpServerIds?: string[];
  // macOS host notification for a settled Chat conversation turn, and its system sound name; an
  // empty sound name delivers the notification silently.
  turnNotificationsEnabled?: boolean;
  turnNotificationSound?: string;
  expectedConfigurationRevision?: number;
};

export type WorkliteFixedNavigationTarget =
  | 'home'
  | 'chat'
  | 'skills'
  | 'mcp-servers'
  | 'model-providers'
  | 'logs'
  | 'workflows'
  | 'settings-appearance'
  | 'settings-usage'
  | 'settings-audit-log';

// A Workflow editor target addresses one workflow by id, such as `/workflows/wf_...`.
export type WorkliteNavigationTarget = WorkliteFixedNavigationTarget | `/workflows/${string}`;

export type WorkspaceSettingsView = {
  appearance: 'system' | 'light' | 'dark';
  updatedAt: string;
};

export type UpdateWorkspaceSettingsRequest = Partial<Pick<WorkspaceSettingsView, 'appearance'>>;

export type PortkeyGatewayStatus = 'starting' | 'running' | 'failed';

export type PortkeyGatewayView = {
  port: number;
  host: string;
  status: PortkeyGatewayStatus;
  error: string | null;
  updatedAt: string;
};

export type CodexAccountView = {
  id: string;
  name: string;
  enabled: boolean;
  autoPauseOnExpired: boolean;
  concurrency: number;
  priority: number;
  rateMultiplier: number;
  email: string | null;
  accountId: string | null;
  planType: string | null;
  expiresAt: string | null;
  status: 'connected' | 'expired' | 'disabled' | 'error';
  error?: string;
};

export type CodexAuthStatus = {
  status: 'connected' | 'disconnected' | 'login_pending' | 'error';
  authMethod: 'oauth' | 'environment' | null;
  email: string | null;
  accountId: string | null;
  planType: string | null;
  expiresAt: string | null;
  accounts: CodexAccountView[];
  authorizationUrl?: string;
  sessionId?: string;
  error?: string;
};

export type CodexRateLimitWindow = {
  usedPercent: number;
  limitWindowSeconds: number;
  resetsAt: string;
};

export type CodexRateLimit = {
  id: string;
  name: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
};

export type CodexRateLimitSnapshot = {
  planType: string | null;
  limits: CodexRateLimit[];
};

export type CodexAccountUsageView = {
  accountId: string;
  status: 'connected' | 'disabled' | 'expired' | 'error' | 'unavailable';
  planType: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  fetchedAt: string | null;
  error?: string;
};

export type CodexAccountUsageSnapshot = {
  accounts: CodexAccountUsageView[];
  fetchedAt: string;
};

export type GatewayTimeRange = {
  from?: string;
  to?: string;
};

/**
 * The platform features a Gateway request can be charged to. Every WorkLite path
 * that reaches the Gateway declares exactly one of these; a request that declares
 * none is recorded as `unattributed` rather than joining another surface's totals.
 */
export const GATEWAY_SURFACES = [
  'chat',
  'chat_project_task',
  'agent',
  'workflow',
  'team',
  'team_project_task',
  'provider_test',
  'external',
  'unattributed',
] as const;

export type GatewaySurface = (typeof GATEWAY_SURFACES)[number];

export const GATEWAY_STATS_GROUP_BYS = ['surface', 'conversation', 'executor', 'team', 'workflow'] as const;

export type GatewayStatsGroupBy = (typeof GATEWAY_STATS_GROUP_BYS)[number];

/** Filters that select one surface's traffic; they apply to statistics and details alike. */
export type GatewayAttributionFilters = {
  surface?: GatewaySurface;
  conversationId?: string;
  projectTaskId?: string;
  executor?: string;
  teamId?: string;
  teamRunId?: string;
  workflowId?: string;
  workflowRunId?: string;
};

export type GatewayAttributionGroup = {
  /** Stable identity of this group within the active groupBy. */
  key: string;
  surface: GatewaySurface | null;
  conversationId: string | null;
  executor: string | null;
  teamId: string | null;
  teamRunId: string | null;
  workflowId: string | null;
  workflowRunId: string | null;
  requests: number;
  successful: number;
  failed: number;
  averageLatencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  totalTokens: number | null;
  usageRequests: number;
};

export type PortkeyGatewayStatsBreakdown = {
  provider: string;
  model: string;
  requests: number;
  successful: number;
  failed: number;
  averageLatencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  totalTokens: number | null;
  usageRequests: number;
  endpoints: Array<{ endpoint: string; requests: number }>;
  statuses: Array<{ status: number; requests: number }>;
};

export type PortkeyGatewayStats = {
  from: string;
  to: string;
  summary: {
    requests: number;
    successful: number;
    failed: number;
    successRate: number | null;
    averageLatencyMs: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
    totalTokens: number | null;
    usageRequests: number;
  };
  breakdown: PortkeyGatewayStatsBreakdown[];
  /**
   * Usage grouped by platform surface rather than provider and model. It is additive:
   * `summary` and `breakdown` keep their original meaning, so a reader built before
   * attribution existed is unaffected.
   */
  attribution: {
    groupBy: GatewayStatsGroupBy;
    groups: GatewayAttributionGroup[];
  };
};

export type PortkeyGatewayStatsQuery = GatewayTimeRange & GatewayAttributionFilters & {
  groupBy?: GatewayStatsGroupBy;
};

export type PortkeyGatewayModel = {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
};

export type PortkeyGatewayModelList = {
  object: 'list';
  data: PortkeyGatewayModel[];
};

export type WorkliteScriptResult =
  | { type: 'resource'; resourceType: 'provider' | 'skill' | 'mcp-server' | 'workflow'; id: string; route: string }
  | { type: 'navigation'; target: WorkliteNavigationTarget; route: string }
  | { type: 'settings'; appearance: WorkspaceSettingsView['appearance'] }
  | { type: 'dispatch'; submissionId: string; route: string }
  | { type: 'snapshot' };

export type WorkflowNodePosition = {
  x: number;
  y: number;
};

export type WorkflowNodeDefinition = {
  id: string;
  position: WorkflowNodePosition;
  type: string;
  typeVersion: string;
  config: unknown;
  errorPolicy: NodeErrorPolicy;
};

export type WorkflowEdgePredicateOperator =
  | 'equals'
  | 'notEquals'
  | 'truthy'
  | 'falsy'
  | 'exists'
  | 'notExists'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual';

export type WorkflowEdgeCondition =
  | {
      kind: 'predicate';
      path: string;
      operator: WorkflowEdgePredicateOperator;
      value?: unknown;
    }
  | { kind: 'fallback' };

export type WorkflowEdgeDefinition = {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
  condition?: WorkflowEdgeCondition;
  maxTraversals?: number;
};

export type WorkflowDefinition = {
  schemaVersion: number;
  input: { example?: unknown };
  defaults: { errorPolicy: NodeErrorPolicy };
  nodes: WorkflowNodeDefinition[];
  edges: WorkflowEdgeDefinition[];
};

export type WorkflowEditOperation =
  | { type: 'addNode'; node: WorkflowNodeDefinition; index: number }
  | { type: 'removeNode'; nodeId: string }
  | { type: 'updateNode'; nodeId: string; patch: Partial<Omit<WorkflowNodeDefinition, 'id'>> }
  | { type: 'moveNode'; nodeId: string; position: WorkflowNodePosition }
  | { type: 'addEdge'; edge: WorkflowEdgeDefinition }
  | { type: 'removeEdge'; edgeId: string }
  | { type: 'updateSettings'; input?: { example?: unknown }; defaults?: { errorPolicy: NodeErrorPolicy } };

export type WorkflowPlanNode = {
  key: string;
  type: string;
  typeVersion?: string;
  config: unknown;
  errorPolicy?: NodeErrorPolicy;
};

export type WorkflowPlanEdge = {
  source: string;
  target: string;
  sourcePort?: string;
  targetPort?: string;
  condition?: WorkflowEdgeCondition;
  maxTraversals?: number;
};

export type WorkflowPlan = {
  nodes: WorkflowPlanNode[];
  edges: WorkflowPlanEdge[];
  input?: { example?: unknown };
  defaults?: { errorPolicy: NodeErrorPolicy };
};

export type WorkflowDraftView = {
  id: string;
  workflowId: string;
  revisionId: string;
  definition: WorkflowDefinition;
  canUndo: boolean;
  canRedo: boolean;
  updatedAt: string;
};

export type WorkflowRevisionView = {
  id: string;
  workflowId: string;
  parentRevisionId: string | null;
  source: 'manual' | 'assistant' | 'migration';
  sourceInstruction: string | null;
  operations: WorkflowEditOperation[];
  createdAt: string;
};

export type WorkflowDashboardFieldType = 'text' | 'number' | 'boolean' | 'datetime' | 'url';

export type WorkflowDashboardField = {
  key: string;
  label: string;
  type: WorkflowDashboardFieldType;
};

export type WorkflowDashboardElement =
  | { kind: 'text'; text: string }
  | { kind: 'count'; label: string }
  | { kind: 'metric'; label: string; field: string; type: WorkflowDashboardFieldType }
  | { kind: 'list'; titleKey: string; fields: WorkflowDashboardField[] };

export type WorkflowDashboardLayout = {
  header: WorkflowDashboardElement[];
  main: WorkflowDashboardElement[];
  footer: WorkflowDashboardElement[];
};

export type WorkflowDashboardBinding = {
  nodeId: string;
  layout: WorkflowDashboardLayout;
};

export type WorkflowView = {
  id: string;
  workspaceSlug: string;
  latestVersionId: string | null;
  latestVersion: number | null;
  name: string;
  state: 'draft' | 'published';
  stepCount: number;
  dashboard: WorkflowDashboardBinding | null;
  lastRunStatus: RunStatus | null;
  lastRunAt: string | null;
  updatedAt: string;
};

export type WorkflowDetailView = WorkflowView & {
  draft: WorkflowDraftView;
};
export type HomeBoardCategoryView = {
  id: string;
  workspaceSlug: string;
  name: string;
  position: number;
  workflowIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type HomeBoardPreferencesView = {
  categories: HomeBoardCategoryView[];
};

export type CreateHomeBoardCategoryRequest = {
  name: string;
};

export type UpdateHomeBoardCategoryRequest = {
  name: string;
};

export type AssignHomeBoardRequest = {
  workflowId: string;
  categoryId: string | null;
};


export type ApplyWorkflowDraftOperationsRequest = {
  baseRevisionId: string;
  operations?: WorkflowEditOperation[];
  plan?: WorkflowPlan;
  source?: 'manual' | 'assistant';
  sourceInstruction?: string;
};

export type ReplaceWorkflowDraftAgentModelsRequest = {
  baseRevisionId: string;
  fromModel: string;
  toModel: string;
  nodeIds?: string[];
  source?: 'manual' | 'assistant';
  sourceInstruction?: string;
};

export type CreateWorkflowRequest = {
  name: string;
  definition?: WorkflowDefinition;
};

export type PortableWorkflowSkillReference = {
  name: string;
};

export type PortableWorkflowMcpServerReference = {
  name: string;
};

export type PortableWorkflowNodeDefinition = Omit<WorkflowNodeDefinition, 'config'> & {
  config: Record<string, unknown> & {
    skills?: PortableWorkflowSkillReference[];
    mcpServers?: PortableWorkflowMcpServerReference[];
  };
};

export type PortableWorkflowDocument = {
  format: 'worklite.workflow';
  version: 1;
  workflow: {
    name: string;
    definition: Omit<WorkflowDefinition, 'nodes'> & { nodes: PortableWorkflowNodeDefinition[] };
  };
};

export type ImportWorkflowRequest = PortableWorkflowDocument;

export type WorkflowVersionView = {
  id: string;
  workflowId: string;
  version: number;
  schemaVersion: number;
  definition: WorkflowDefinition;
  sourceRevisionId: string | null;
  publishedAt: string;
  publishedBy: string;
};

export type RunView = {
  id: string;
  workspaceSlug: string;
  workflowId: string;
  workflowName: string;
  version: string;
  status: RunStatus;
  currentStep: string | null;
  startedAt: string;
  durationSeconds: number | null;
  initiator: string;
  input?: unknown;
  result?: unknown;
  hasArtifactNode: boolean;
  resumable: boolean;
  nodeRuns?: WorkflowNodeRunView[];
  artifacts?: ArtifactView[];
  pendingAction?: WorkflowPendingActionView | null;
};

export type CreateRunRequest = {
  input: unknown;
};

export type CreateRunResponse = {
  runId: string;
};

export type WorkflowRunView = {
  id: string;
  workspaceId: string;
  workflowVersionId: string;
  status: RunStatus;
  currentNodeId: string | null;
  input: unknown;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type WorkflowNodeRunStatus = 'queued' | 'running' | 'waiting_for_input' | 'succeeded' | 'failed' | 'cancelled';

export type WorkflowPendingActionType = 'wechat_login' | 'wechat_publish_confirmation';

export type WorkflowPendingActionStatus = 'pending' | 'completed' | 'expired' | 'cancelled';

export type WorkflowPendingActionView = {
  id: string;
  runId: string;
  nodeRunId: string;
  type: WorkflowPendingActionType;
  status: WorkflowPendingActionStatus;
  title: string;
  description: string;
  qrCode: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowNodeRunView = {
  id: string;
  runId: string;
  nodeId: string;
  position: number;
  type: string;
  typeVersion: string;
  status: WorkflowNodeRunStatus;
  input: unknown;
  output: unknown;
  artifactIds: string[];
  error: string | null;
  retryCount: number;
  retryable: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  streamedOutput: string | null;
  activity: WorkflowNodeActivityView[];
};

export type RunProgressEvent = {
  runId: string;
  sequence: number;
  type: 'run.status' | 'node.started' | 'node.delta' | 'node.waiting' | 'node.completed' | 'node.failed' | 'node.activity' | 'pending_action.updated' | 'artifact.created';
  payload: unknown;
  occurredAt: string;
};

export type WorkflowNodeActivityPhase =
  | 'node.setup'
  | 'node.attempt'
  | 'model.round'
  | 'skill.script'
  | 'mcp.call'
  | 'map.element'
  | 'edge.decision';

export type WorkflowNodeActivityEdgeDecision = {
  edgeId: string;
  targetNodeId: string;
  targetPort: string;
  traversed: boolean;
  condition: string;
  traversals: number;
  maxTraversals: number | null;
};

export type WorkflowNodeActivityDetail =
  | { phase: 'node.setup'; type: string; typeVersion: string; errorPolicy: 'stop' | 'retry'; config: unknown; inputPorts: string[] }
  | { phase: 'node.attempt'; attempt: number; attempts: number; automaticRetry: boolean }
  | { phase: 'model.round'; round: number; model: string; finishReason: string | null; toolCalls: number; contextDropped: number }
  | { phase: 'skill.script'; skillId: string; skillName: string; scriptPath: string; arguments: string[]; commandExecutionId: string; exitCode: number | null; status: 'succeeded' | 'failed' }
  | { phase: 'mcp.call'; serverId: string; toolName: string; input: unknown; result: string; status: 'succeeded' | 'failed' }
  | { phase: 'map.element'; index: number; total: number; status: 'succeeded' | 'failed' | 'skipped'; message?: string }
  | { phase: 'edge.decision'; decisions: WorkflowNodeActivityEdgeDecision[]; terminal: boolean };

export type WorkflowNodeActivityEventPayload = {
  nodeId: string;
  nodeRunId: string;
  phase: WorkflowNodeActivityPhase;
  detail: WorkflowNodeActivityDetail;
};

export type WorkflowNodeActivityView = WorkflowNodeActivityEventPayload & {
  sequence: number;
  occurredAt: string;
};

export type SkillRoot = 'agents' | 'platform';

export type SkillConflictView = {
  ignoredRoot: 'platform';
  ignoredPath: string;
  reason: string;
};

export type SkillView = {
  id: string;
  workspaceSlug: string;
  name: string;
  source: 'local';
  root: SkillRoot;
  rootPath: string;
  directory: string;
  version: string;
  validation: 'valid' | 'invalid' | 'pending';
  validationReason?: string;
  conflict?: SkillConflictView;
  description?: string;
  metadata?: Record<string, unknown>;
  files: Array<{
    path: string;
    content: string;
  }>;
  updatedAt: string;
};

export type SkillReferenceCleanup = {
  agentIds: string[];
  chatConfigurationRevisions: number[];
  workflowDrafts: Array<{ workflowId: string; nodeIds: string[] }>;
  agentTeamRoles: Array<{ teamId: string; role: string }>;
  agentTeamDeveloperInstances: Array<{ teamId: string; role: string; developerId: string }>;
};

export type DeleteSkillResult = {
  deleted: string;
  directory: string;
  root: SkillRoot;
  directoryPath: string;
  cleaned: SkillReferenceCleanup;
};

export type McpServerView = {
  id: string;
  workspaceSlug: string;
  name: string;
  endpoint: string;
  connection: 'connected' | 'unreachable' | 'auth_failed' | 'unconfigured';
  connectionError: 'authentication' | 'unreachable' | 'unsupported_protocol' | 'malformed_response' | null;
  transport: 'Streamable HTTP';
  allowedTools: number;
  allowedToolNames: string[];
  version: string;
  updatedAt: string;
};

// Every place a workspace MCP server is referenced, reported when its deletion
// is rejected. Drafts and active Team role configuration are mutable and can be
// cleaned by a force deletion; published WorkflowVersions and captured
// TeamVersions are immutable history and are never rewritten; Chat and legacy
// Agent references always block deletion until cleared by their owner.
export type McpServerReferenceReport = {
  agents: Array<{ agentId: string; agentName: string }>;
  activeChatTurns: boolean;
  chatConfiguration: boolean;
  workflowDrafts: Array<{ workflowId: string; workflowName: string; nodeIds: string[] }>;
  workflowVersions: Array<{ workflowId: string; workflowName: string; version: number; nodeIds: string[] }>;
  agentTeamRoles: Array<{ teamId: string; teamName: string; role: string; displayName: string | null }>;
  agentTeamVersions: Array<{ teamId: string; versionId: string; version: number; roles: string[] }>;
};

export type DeleteMcpServerResult = {
  deleted: string;
  force: boolean;
  cleaned: { workflowDrafts: number; agentTeamRoles: number };
};

export type ModelProviderProtocol = 'openai/chat' | 'openai/responses' | 'anthropic/messages' | 'codex/responses' | 'typesafe/systemone';

export type ModelProviderView = {
  id: string;
  name: string;
  baseURL: string | null;
  protocol: ModelProviderProtocol;
  status: 'connected' | 'unconfigured' | 'invalid';
  apiKey: string;
  maskedKey: string;
  models: string[];
  headerNames: string[];
};

export type SystemOneTestInput = {
  state: {
    message: string;
  };
  questions: {
    connection: {
      type: 'noul';
      instructions: string;
    };
  };
};

export type SystemOneTestOutput = {
  answers: {
    connection: {
      type: 'noul';
      noul: number;
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
};

export type SystemOneWorkflowOutput = {
  answers: Record<string, unknown>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
};

export type SystemOneWorkflowRequest = {
  model: string;
  state: unknown;
  questions: Record<string, unknown>;
};

export type ModelProviderTestResult =
  | {
    protocol: 'typesafe/systemone';
    model: string;
    input: SystemOneTestInput;
    output: SystemOneTestOutput;
    traceId: string;
  }
  | {
    protocol: Exclude<ModelProviderProtocol, 'typesafe/systemone'>;
    model: string;
    prompt: string;
    response: string;
    traceId: string;
  };

export type TestModelProviderRequest = {
  model: string;
};

/**
 * The coarse label that predates surfaces. It is kept so readers and filters built on
 * it keep working; `surface` on the same record carries the detail it cannot express.
 */
export type GatewayRequestLogSource = 'chat' | 'agent' | 'workflow' | 'team' | 'provider_test' | 'external' | 'proxy';

export type GatewayRequestLogStatusClass = 'success' | 'client_error' | 'server_error';

export type GatewayRequestLogListItem = {
  id: string;
  occurredAt: string;
  provider: string;
  model: string;
  endpoint: string;
  status: number;
  durationMs: number;
  streaming: boolean;
  source: GatewayRequestLogSource | null;
  surface: GatewaySurface;
  conversationId: string | null;
  projectTaskId: string | null;
  executor: string | null;
  workflowId: string | null;
  workflowRunId: string | null;
  nodeRunId: string | null;
  teamId: string | null;
  teamRunId: string | null;
  teamRole: string | null;
  teamTaskAttemptId: string | null;
  teamOperationKey: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  totalTokens: number | null;
};

export type GatewayRequestLogResponseCapture =
  | { kind: 'json'; body: unknown }
  | { kind: 'text'; body: string }
  | { kind: 'stream'; events: unknown[] }
  | { kind: 'unavailable'; reason: string };

export type GatewayRequestLogDetail = GatewayRequestLogListItem & {
  request: unknown;
  response: GatewayRequestLogResponseCapture;
};

export type GatewayRequestLogQuery = GatewayTimeRange & GatewayAttributionFilters & {
  provider?: string;
  model?: string;
  statusClass?: GatewayRequestLogStatusClass;
  limit?: number;
  cursor?: string;
};

export type GatewayRequestLogList = {
  items: GatewayRequestLogListItem[];
  nextCursor: string | null;
  retentionHours: number;
  /**
   * The range actually served. It is the requested range intersected with the
   * retention window, so a client can tell that an earlier part of what it asked
   * for has already expired rather than being quiet.
   */
  from: string;
  to: string;
  retainedFrom: string;
};

export type ArtifactView = {
  id: string;
  workspaceSlug: string;
  name: string;
  type: 'json' | 'text' | 'markdown' | 'image' | 'unsupported';
  workflowId: string | null;
  workflowName: string;
  runId: string;
  size: string;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  sizeBytes?: number | null;
  contentUrl?: string | null;
  createdAt: string;
  content: string;
};

/** A list row keeps only what the reading page needs; the full content stays in the detail call. */
export type ArtifactListItemView = {
  id: string;
  workspaceSlug: string;
  name: string;
  type: 'json' | 'text' | 'markdown' | 'image' | 'unsupported';
  workflowId: string | null;
  workflowName: string;
  runId: string;
  size: string;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  sizeBytes?: number | null;
  contentUrl?: string | null;
  createdAt: string;
  contentLength: number;
  summary: string;
};

export type ArtifactListPageView = {
  items: ArtifactListItemView[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type ArtifactListQuery = {
  search?: string;
  workflowId?: string;
  page?: number;
  pageSize?: number;
};

/**
 * A `worklite-image:<key>` reference and the URL resolved from the run, when one
 * exists. `url` stays null when only the WeChat draft holds the uploaded image.
 */
export type ArtifactInlineImageView = {
  key: string;
  alt: string;
  url: string | null;
};

export type ArtifactDetailView = ArtifactView & {
  contentLength: number;
  inlineImages: ArtifactInlineImageView[];
};

export type AuditEventView = {
  id: string;
  actor: string;
  action: string;
  resource: string;
  timestamp: string;
  metadata: string;
};

export type UsageRow = {
  model: string;
  tokens: number;
  runs: number;
  cost: number;
};

export type CreateModelProviderRequest = {
  name: string;
  protocol: ModelProviderView['protocol'];
  apiKey?: string;
  baseURL?: string;
  models?: string[];
  headers?: Record<string, string>;
};

export type UpdateModelProviderRequest = {
  name?: string;
  protocol?: ModelProviderView['protocol'];
  apiKey?: string;
  baseURL?: string;
  models?: string[];
  headers?: Record<string, string>;
};

export type DiscoverModelProviderRequest = {
  protocol: CreateModelProviderRequest['protocol'];
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
};

export type DiscoverModelProviderResult = {
  models: string[];
};

export type CreateMcpServerRequest = {
  name: string;
  endpoint: string;
  authToken?: string;
  allowedTools?: string[];
};

export type UpdateMcpServerRequest = Partial<CreateMcpServerRequest>;

export type McpServerTestResult = {
  connection: 'connected' | 'unreachable' | 'auth_failed';
  tools: Array<{ name: string; description?: string }>;
  error?: 'authentication' | 'unreachable' | 'unsupported_protocol' | 'malformed_response';
};

export type CreateSkillRequest = {
  name: string;
  files: Array<{
    path: string;
    content: string;
  }>;
};

export type ImportSkillRequest = {
  name: string;
  files: Array<{
    path: string;
    content: string;
  }>;
};

export type ExecuteSkillScriptRequest = {
  scriptPath: string;
  arguments: string[];
};

export type WorkflowScheduleView = {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowVersionId: string;
  workflowVersion: number;
  intervalSeconds: number;
  enabled: boolean;
  running: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastStatus: RunStatus | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentTeamRole =
  | 'planner'
  | 'test_designer'
  | 'developer'
  | 'test_author'
  | 'test_runner'
  | 'reviewer'
  | 'worktree-manager';

export type AgentTeamRoleId = string;

export type AgentTeamMode = 'plan_only' | 'validate_existing' | 'implement_and_validate';

export type AgentTeamRoleConfiguration = {
  role: AgentTeamRoleId;
  displayName?: string;
  // One declared model id, or an ordered list of fallback candidates; an empty string keeps the
  // "use the Team/executor default" meaning.
  publicModelId: string | string[];
  instructions: string;
  entryPoints: string[];
  skillIds: string[];
  mcpServerIds: string[];
  toolNames: string[];
  executor?: ProjectExecutor | null;
};

export type AgentTeamDevelopmentAssignmentInput = {
  developerId?: string;
  title: string;
  scopeSummary: string;
  ownedPaths: string[];
  repositoryIds?: string[];
};

export type AgentTeamRoleHandoff = {
  role: AgentTeamRoleId;
  goal: string;
  repositoryIds?: string[];
};

// Worktree Manager setup phase output, validated by the runtime before any
// filesystem effect is executed from it.
export type AgentTeamWorktreeManagerSetupOutput = {
  baseWorktreePath: string;
  runBranch: string;
  lanes: Array<{
    laneId: string;
    worktreePath: string;
    branch: string;
  }>;
};

// Worktree Manager teardown phase output. 'retain' keeps every worktree and
// branch for manual resolution and requires a diagnostic reason.
export type AgentTeamWorktreeManagerTeardownOutput = {
  action: 'merge-and-cleanup' | 'retain';
  reason?: string;
};

export type AgentTeamDevelopmentAssignment = {
  developerId: string;
  title: string;
  scopeSummary: string;
  ownedPaths: string[];
  repositoryIds?: string[];
};

export type AgentTeamRunProgress = {
  phase: 'planning' | 'test_design' | 'development' | 'test_authoring' | 'test_execution' | 'review' | 'repair' | 'waiting' | 'terminal';
  nextStep: 'dispatch_assignments' | 'await_assignment_completion' | 'answer_question' | 'test_authoring' | 'test_execution' | 'review' | 'finish';
  totalAssignments: number;
  completedAssignments: number;
  activeDeveloperIds: string[];
  waitingReason: 'user_input' | 'pause_boundary' | null;
  percent: number;
};

export type AgentTeamView = {
  id: string;
  name: string;
  description: string;
  processId: string;
  processVersion: string;
  roles: AgentTeamRoleConfiguration[];
  workingPractice: string;
  projectGitPolicy: string;
  // Maximum number of simultaneously active Runs; dispatches beyond it queue FIFO.
  maxConcurrentRuns: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentTeamVersionMetadata = {
  id: string;
  version: number;
  createdAt: string;
  developerExecution?: ProjectExecutorLaunchView | { kind: 'codex_app_server' };
  developerExecutions?: Record<string, ProjectExecutorLaunchView | { kind: 'codex_app_server' }>;
  projectExecutorLaunches?: Record<string, ProjectExecutorLaunchView | { kind: 'codex_app_server' }>;
  orchestrationVersion?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
};

export type AgentTeamTaskAttemptStatus =
  | 'running'
  | 'waiting_for_input'
  | 'waiting_for_recovery'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentTeamTaskAttemptView = {
  id: string;
  taskKey: string;
  attemptIndex: number;
  role: AgentTeamRoleId;
  status: AgentTeamTaskAttemptStatus;
  inputFingerprint: string;
  result: AgentTeamTaskResult | null;
  error: string | null;
  retryable: boolean;
  developerId: string | null;
  assignmentTitle: string | null;
  progressText: string;
  // Derived from the captured Team version: the role's display name (null for built-in roles
  // without one) and the public model id the attempt runs on (the role's model, else the Team
  // default for WorkLite Agent roles, else the captured executor launch model).
  roleName: string | null;
  model: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

// The in-flight attempt a compact Run card leads with: the most recently started attempt that is
// running or waiting, plus how many attempts are in flight (parallel Developer lanes).
export type AgentTeamRunCurrentView = {
  taskAttemptId: string;
  taskKey: string;
  role: AgentTeamRoleId;
  roleName: string | null;
  model: string | null;
  status: AgentTeamTaskAttemptStatus;
  assignmentTitle: string | null;
  progressText: string;
  startedAt: string | null;
  activeCount: number;
  activeRoleCount: number;
};

export type AgentTeamDocumentView = {
  id: string;
  runId: string;
  taskAttemptId: string;
  key: string;
  revision: number;
  title: string;
  content: string;
  upstreamDocumentKeys: string[];
  deliveryStatus: 'pending' | 'delivered' | 'failed';
  deliveryError: string | null;
  fileName: string;
  createdAt: string;
};

export type AgentTeamPendingInputView = {
  id: string;
  runId: string;
  taskAttemptId: string;
  kind: 'question' | 'operation_recovery';
  question: string;
  operationKey: string | null;
  scopeRevision: number;
  status: 'pending' | 'answered' | 'cancelled';
  createdAt: string;
  answeredAt: string | null;
};

export type AgentTeamOperationStatus = 'reserved' | 'completed' | 'uncertain' | 'failed';

export type AgentTeamOperationRecoveryDecision =
  | { type: 'adopt_command' }
  | { type: 'mark_failed' }
  | { type: 'replay'; replayOperationKey: string };

export type AgentTeamOperationView = {
  key: string;
  runId: string;
  taskAttemptId: string;
  taskKey: string;
  operationKey: string;
  toolName: string;
  inputFingerprint: string;
  status: AgentTeamOperationStatus;
  commandId: string | null;
  failureReason: string | null;
  recoveryDecision: AgentTeamOperationRecoveryDecision | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentTeamRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_input'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type AgentTeamCriterionAssessment = {
  criterion: string;
  assessment: 'met' | 'unmet' | 'not_verified';
  evidence: string[];
};

export type AgentTeamTaskResultDocument = {
  key: string;
  title: string;
  content: string;
  producingTaskKey: string;
  upstreamDocumentKeys: string[];
};

export type AgentTeamProjectGitDecision = {
  projectPath: string;
  strategy: 'no_git' | 'current_branch' | 'feature_branch' | 'worktree';
  branch?: string;
  worktreePath?: string;
};

export type AgentTeamTaskResult =
  | {
      status: 'completed';
      documents: AgentTeamTaskResultDocument[];
      unresolvedIssues: string[];
      commandIds: string[];
      changedFiles: string[];
      completedAssignedWork: boolean;
      criterionAssessments: AgentTeamCriterionAssessment[];
      projectGitDecisions?: AgentTeamProjectGitDecision[];
      developmentAssignments?: AgentTeamDevelopmentAssignmentInput[];
      repairRequests?: Array<{ developerId: string; instruction: string }>;
      repairRequest?: {
        taskKey: string;
        instruction: string;
      };
      message?: string;
      handoff?: AgentTeamRoleHandoff;
      // Set by the v10 Dispatcher. Other roles never author this field.
      dispatchDecision?: {
        mode: AgentTeamMode;
        rationale: string;
      };
    }
  | {
      status: 'waiting_for_input';
      pendingInput: {
        id: string;
        question: string;
        scopeRevision: number;
      };
    };

export type AgentTeamRunOutcome = {
  summary: string;
  unresolvedIssues: string[];
  criterionAssessments: AgentTeamCriterionAssessment[];
};

export type AgentTeamRunSummary = {
  id: string;
  intent: string;
  projectDirectory: string;
  mode: AgentTeamMode;
  modeRationale: string | null;
  modeDecidedAt: string | null;
  orchestrationVersion: number;
  status: AgentTeamRunStatus;
  createdAt: string;
  finishedAt: string | null;
};

export type AgentTeamGroupRepository = {
  id: string;
  teamRepositoryId: string;
  name: string;
  directory: string;
  createdAt: string;
};

export type AgentTeamRepositoryView = {
  id: string;
  name: string;
  directory: string;
};

export type AgentTeamGroupMessage = {
  id: string;
  sequence: number;
  sender: 'user' | 'role' | 'system';
  senderRole: AgentTeamRoleId | null;
  recipientRole: AgentTeamRoleId | null;
  kind: 'text' | 'question' | 'handoff' | 'control' | 'status' | 'file';
  body: string;
  runId: string | null;
  taskAttemptId: string | null;
  repositoryIds: string[];
  fileReferences: Array<{ documentId: string; revision: number; title: string }>;
  deliveryStatus: 'pending' | 'delivered' | 'failed';
  createdAt: string;
};

export type AgentTeamGroupSummary = {
  id: string;
  title: string;
  mode: AgentTeamMode;
  status: AgentTeamRunStatus | 'empty';
  runCount: number;
  repositories: AgentTeamGroupRepository[];
  lastMessage: AgentTeamGroupMessage | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentTeamGroupView = AgentTeamGroupSummary & {
  teamId: string;
  workingPractice: string;
  messages: AgentTeamGroupMessage[];
  runs: Array<{ id: string; targetRole: AgentTeamRoleId | null; currentRole: AgentTeamRoleId | null; status: AgentTeamRunStatus; intent: string; repositoryIds: string[]; createdAt: string; finishedAt: string | null; pendingInputs: Array<{ id: string; question: string; scopeRevision: number }> }>;
};

export type AgentTeamGroupControlRequest = {
  operation: 'reexecute';
  runIds: string[];
};

export type AgentTeamMemoryView = {
  id: string;
  repositoryId: string | null;
  repositoryName: string | null;
  repositoryDirectory: string | null;
  role: AgentTeamRoleId | null;
  content: string;
  sourceMessageId: string | null;
  // v11 provenance; absent on memories created before the migration.
  sourceRunId?: string | null;
  sourceRole?: AgentTeamRoleId | null;
  sourceTaskAttemptId?: string | null;
  createdBy?: 'chat' | 'role';
  upsertKey?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateAgentTeamMemoryRequest = {
  repositoryId?: string | null;
  role?: AgentTeamRoleId | null;
  content: string;
  sourceMessageId?: string | null;
};

export type UpdateAgentTeamMemoryRequest = Partial<CreateAgentTeamMemoryRequest>;

export type AgentTeamGroupEvent = {
  groupId: string;
  sequence: number;
  type: 'message' | 'repository.updated' | 'run.updated' | 'memory.updated';
  payload: Record<string, unknown>;
  createdAt: string;
};

export type AgentTeamRunView = {
  id: string;
  teamId: string;
  groupId: string | null;
  targetRole: AgentTeamRoleId | null;
  repositoryIds: string[];
  teamVersion: AgentTeamVersionMetadata;
  status: AgentTeamRunStatus;
  intent: string;
  projectDirectory: string;
  mode: AgentTeamMode;
  modeRationale: string | null;
  modeDecidedAt: string | null;
  // Historical evidence only: Runs recorded before Team roles gained direct command
  // execution keep the exact command strings the user had granted. Never written again.
  authorizedCommands: string[];
  scopeRevision: number;
  desiredControlState: 'none' | 'pause_requested' | 'cancel_requested';
  tasks: AgentTeamTaskAttemptView[];
  documents: AgentTeamDocumentView[];
  pendingInputs: AgentTeamPendingInputView[];
  operations: AgentTeamOperationView[];
  activities: AgentTeamRunEvent[];
  progress: AgentTeamRunProgress;
  current: AgentTeamRunCurrentView | null;
  outcome: AgentTeamRunOutcome | null;
  // Run-level worktree evidence recorded by the Worktree Manager stage; null
  // for Runs on orchestration versions without it or before setup completes.
  worktreeBasePath: string | null;
  runBranch: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type AgentTeamRunEventType =
  | 'run.status'
  | 'task.started'
  | 'task.activity'
  | 'task.delta'
  | 'task.waiting'
  | 'task.completed'
  | 'task.failed'
  | 'document.committed'
  | 'document.delivered'
  | 'document.delivery_failed'
  | 'operation.updated'
  | 'input.requested'
  | 'input.answered'
  | 'run.outcome'
  | 'run.progress';

export type AgentTeamRunEvent = {
  runId: string;
  sequence: number;
  type: AgentTeamRunEventType;
  payload: unknown;
  createdAt: string;
};

export type AgentTeamDocumentDownloadView = {
  fileName: string;
  content: string;
};

export type UpdateAgentTeamRequest = {
  roles?: AgentTeamRoleConfiguration[];
  maxConcurrentRuns?: number;
  workingPractice?: string;
  projectGitPolicy?: string;
};

export type CreateAgentTeamRunRequest = {
  intent: string;
  projectDirectory: string;
  mode: AgentTeamMode;
};

export type CreateAgentTeamRunResponse = {
  run: AgentTeamRunView;
};

export type AnswerAgentTeamRunRequest = {
  pendingInputId: string;
  scopeRevision: number;
  answer: string;
  directories?: string[];
};

export type RecoverAgentTeamOperationRequest = {
  operationKey: string;
  decision: 'adopt_command' | 'mark_failed' | 'replay';
};

export type AgentTeamRunActionResponse = {
  run: AgentTeamRunView;
};
