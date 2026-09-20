export type RunStatus =
  | 'queued'
  | 'running'
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
  id: 'codex-cli-chat' | 'wechat-official-account';
  name: string;
  description: string;
  command: string;
  enabled: boolean;
  status: 'available' | 'missing' | 'failed';
  updatedAt: string;
  wechat: WechatConnectionView;
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

export type WechatConnectionStatus = 'disconnected' | 'qr_pending' | 'connected' | 'error';

export type WechatConnectionView = {
  status: WechatConnectionStatus;
  baseUrl: string;
  botId: string | null;
  qrCode: string | null;
  lastError: string | null;
  conversationCount: number;
  updatedAt: string;
};

export type UpdatePluginRequest = {
  command: string;
};

export type PluginTestResult = {
  enabled: boolean;
  status: 'available' | 'missing' | 'failed';
};

export type AgentView = {
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
  | 'invalid_request'
  | 'invalid_tool_request'
  | 'incomplete_tool_request'
  | 'too_many_tool_calls'
  | 'skill'
  | 'mcp'
  | 'restarted'
  | 'internal';

export type AgentExecutionMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

export type AgentPlanStep = {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
};

export type AgentPendingQuestion = {
  id: string;
  question: string;
  options: string[];
  createdAt: string;
};

export type AgentToolCallStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type AgentToolCallView = {
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

export type AgentExecutionView = {
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
  | { kind: 'message_delta'; messageId: string; delta: string }
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
};

export type WorkliteNavigationTarget =
  | 'home'
  | 'system-helper-chat'
  | 'skills'
  | 'mcp-servers'
  | 'model-providers'
  | 'workflows'
  | 'settings-appearance'
  | 'settings-usage'
  | 'settings-audit-log';

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

export type PortkeyGatewayStatsWindow = '24h' | '7d' | '30d';

export type PortkeyGatewayStatsBreakdown = {
  provider: string;
  model: string;
  requests: number;
  successful: number;
  failed: number;
  averageLatencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  usageRequests: number;
  endpoints: Array<{ endpoint: string; requests: number }>;
  statuses: Array<{ status: number; requests: number }>;
};

export type PortkeyGatewayStats = {
  window: PortkeyGatewayStatsWindow;
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
    totalTokens: number | null;
    usageRequests: number;
  };
  breakdown: PortkeyGatewayStatsBreakdown[];
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

export type SkillView = {
  id: string;
  workspaceSlug: string;
  name: string;
  source: 'online' | 'archive' | 'built-in';
  version: string;
  validation: 'valid' | 'invalid' | 'pending';
  files: Array<{
    path: string;
    content: string;
  }>;
  updatedAt: string;
};

export type McpServerView = {
  id: string;
  workspaceSlug: string;
  name: string;
  endpoint: string;
  connection: 'connected' | 'unreachable' | 'auth_failed' | 'unconfigured';
  transport: 'Streamable HTTP';
  allowedTools: number;
  allowedToolNames: string[];
  version: string;
  updatedAt: string;
};

export type ModelProviderProtocol = 'openai/chat' | 'openai/responses' | 'anthropic/messages' | 'codex/responses';

export type ModelProviderView = {
  id: string;
  name: string;
  baseURL: string | null;
  protocol: ModelProviderProtocol;
  status: 'connected' | 'unconfigured' | 'invalid';
  maskedKey: string;
  models: string[];
  headerNames: string[];
};

export type ModelProviderTestResult = {
  prompt: string;
  model: string;
  response: string;
  traceId: string;
};

export type TestModelProviderRequest = {
  model: string;
};

export type GatewayRequestLogSource = 'agent' | 'workflow' | 'provider_test' | 'proxy';

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
  workflowRunId: string | null;
  nodeRunId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
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

export type GatewayRequestLogQuery = {
  provider?: string;
  model?: string;
  statusClass?: GatewayRequestLogStatusClass;
  workflowRunId?: string;
  limit?: number;
  cursor?: string;
};

export type GatewayRequestLogList = {
  items: GatewayRequestLogListItem[];
  nextCursor: string | null;
  retentionDays: number;
};

export type ArtifactView = {
  id: string;
  workspaceSlug: string;
  name: string;
  type: 'json' | 'text' | 'markdown' | 'unsupported';
  workflowName: string;
  runId: string;
  size: string;
  createdAt: string;
  content: string;
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
  source?: 'online';
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

export type UpdateSkillRequest = {
  name?: string;
  files?: Array<{
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
