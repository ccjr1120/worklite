export type RunStatus =
  | 'queued'
  | 'running'
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
  id: 'codex-cli-chat';
  name: string;
  description: string;
  command: string;
  enabled: boolean;
  status: 'available' | 'missing' | 'failed';
  updatedAt: string;
  wechat: WechatConnectionView;
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

export type CreateScheduledAgentTaskRequest = {
  agentId: string;
  prompt: string;
  intervalSeconds: number;
  label?: string;
};

export type ScheduledAgentTaskView = {
  id: string;
  agentId: string;
  agentName: string;
  label: string;
  prompt: string;
  intervalSeconds: number;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: AgentExecutionStatus | null;
  unread: boolean;
  running: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateAgentSubSessionRequest = {
  agentId: string;
  message: string;
};

export type UpdateAgentSubSessionRequest = {
  unread: boolean;
};

export type AgentSubSessionView = {
  id: string;
  agentId: string;
  agentName: string;
  agentInitials: string;
  executionId: string;
  title: string;
  unread: boolean;
  status: AgentExecutionStatus;
  createdAt: string;
  updatedAt: string;
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
  | 'agents'
  | 'system-helper-chat'
  | 'skills'
  | 'mcp-servers'
  | 'model-providers'
  | 'workflows'
  | 'runs'
  | 'artifacts'
  | 'settings-appearance'
  | 'settings-usage'
  | 'settings-audit-log';

export type WorkspaceSettingsView = {
  appearance: 'system' | 'light' | 'dark';
  locale: 'en' | 'zh-CN';
  updatedAt: string;
};

export type UpdateWorkspaceSettingsRequest = Partial<Pick<WorkspaceSettingsView, 'appearance' | 'locale'>>;

export type PortkeyGatewayStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export type PortkeyGatewayView = {
  port: number;
  host: string;
  status: PortkeyGatewayStatus;
  error: string | null;
  updatedAt: string;
};

export type UpdatePortkeyGatewayRequest = {
  port: number;
};

export type WorkliteScriptResult =
  | { type: 'resource'; resourceType: 'provider' | 'agent' | 'skill' | 'mcp-server' | 'workflow'; id: string; route: string }
  | { type: 'navigation'; target: WorkliteNavigationTarget; route: string }
  | { type: 'settings'; appearance: WorkspaceSettingsView['appearance']; locale: WorkspaceSettingsView['locale'] }
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

export type WorkflowEdgeDefinition = {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
};

export type WorkflowDefinition = {
  schemaVersion: number;
  input: { example?: unknown };
  defaults: { errorPolicy: NodeErrorPolicy };
  nodes: WorkflowNodeDefinition[];
  edges: WorkflowEdgeDefinition[];
};

export type WorkflowSkillSetValue = {
  type: 'skill-set';
  skillIds: string[];
};

export type WorkflowEditOperation =
  | { type: 'addNode'; node: WorkflowNodeDefinition; index: number }
  | { type: 'removeNode'; nodeId: string }
  | { type: 'updateNode'; nodeId: string; patch: Partial<Omit<WorkflowNodeDefinition, 'id'>> }
  | { type: 'moveNode'; nodeId: string; position: WorkflowNodePosition }
  | { type: 'addEdge'; edge: WorkflowEdgeDefinition }
  | { type: 'removeEdge'; edgeId: string }
  | { type: 'updateSettings'; input?: { example?: unknown }; defaults?: { errorPolicy: NodeErrorPolicy } };

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

export type WorkflowView = {
  id: string;
  workspaceSlug: string;
  latestVersionId: string | null;
  latestVersion: number | null;
  name: string;
  state: 'draft' | 'published';
  stepCount: number;
  lastRunStatus: RunStatus | null;
  lastRunAt: string | null;
  updatedAt: string;
};

export type WorkflowDetailView = WorkflowView & {
  draft: WorkflowDraftView;
};

export type ApplyWorkflowDraftOperationsRequest = {
  baseRevisionId: string;
  operations: WorkflowEditOperation[];
  source?: 'manual' | 'assistant';
  sourceInstruction?: string;
};

export type CreateWorkflowRequest = {
  name: string;
  definition?: WorkflowDefinition;
};

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
  nodeRuns?: WorkflowNodeRunView[];
  artifacts?: ArtifactView[];
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

export type WorkflowNodeRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

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
  startedAt: string | null;
  finishedAt: string | null;
};

export type RunProgressEvent = {
  runId: string;
  sequence: number;
  type: 'run.status' | 'node.started' | 'node.delta' | 'node.completed' | 'node.failed' | 'artifact.created';
  payload: unknown;
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

export type ModelProviderProtocol = 'openai/chat' | 'openai/responses' | 'deepseek/chat';

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
  protocol?: ModelProviderView['protocol'];
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
  protocol?: CreateModelProviderRequest['protocol'];
  apiKey: string;
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
