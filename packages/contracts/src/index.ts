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
  updatedAt: string;
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

export type WorkliteScriptResult =
  | { type: 'resource'; resourceType: 'provider' | 'agent' | 'skill' | 'mcp-server' | 'workflow'; id: string; route: string }
  | { type: 'navigation'; target: WorkliteNavigationTarget; route: string }
  | { type: 'settings'; appearance: WorkspaceSettingsView['appearance']; locale: WorkspaceSettingsView['locale'] }
  | { type: 'snapshot' };

export type WorkflowInputMapping =
  | { source: 'workflow.input' }
  | { source: 'previous.output' }
  | { source: 'literal'; value: unknown };

export type WorkflowNodeDefinition = {
  id: string;
  position: number;
  type: string;
  typeVersion: string;
  config: unknown;
  input: WorkflowInputMapping;
  errorPolicy: NodeErrorPolicy;
};

export type WorkflowDefinition = {
  schemaVersion: number;
  input: { example?: unknown };
  defaults: { errorPolicy: NodeErrorPolicy };
  nodes: WorkflowNodeDefinition[];
};

export type WorkflowEditOperation =
  | { type: 'addNode'; node: WorkflowNodeDefinition; index: number }
  | { type: 'removeNode'; nodeId: string }
  | { type: 'updateNode'; nodeId: string; patch: Partial<Omit<WorkflowNodeDefinition, 'id' | 'position'>> }
  | { type: 'moveNode'; nodeId: string; index: number }
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

export type RunProgressEvent = {
  runId: string;
  type: 'run.status' | 'node.started' | 'node.completed' | 'node.failed';
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
  connection: 'connected' | 'unreachable' | 'auth_failed' | 'unconfigured';
  transport: 'Streamable HTTP';
  allowedTools: number;
  version: string;
  updatedAt: string;
};

export type ModelProviderView = {
  id: string;
  name: string;
  kind: 'deepseek' | 'openai' | 'openai-compatible';
  baseUrl: string | null;
  organization: string | null;
  project: string | null;
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
  kind?: 'deepseek' | 'openai' | 'openai-compatible';
  apiKey?: string;
  baseUrl?: string;
  organization?: string;
  project?: string;
  models?: string[];
  headers?: Record<string, string>;
};

export type CreateMcpServerRequest = {
  name: string;
  endpoint: string;
  authToken?: string;
};

export type UpdateMcpServerRequest = Partial<CreateMcpServerRequest>;

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
