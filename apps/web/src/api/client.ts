import type {
  AgentView,
  AgentTeamView,
  UpdateAgentTeamRequest,
  CreateAgentTeamRunRequest,
  CreateAgentTeamRunResponse,
  AgentTeamRunView,
  AgentTeamRunEvent,
  AnswerAgentTeamRunRequest,
  RecoverAgentTeamOperationRequest,
  AgentTeamRunActionResponse,
  AgentExecutionView,
  AnswerAgentQuestionRequest,
  CreateRunRequest,
  CreateWorkflowRequest,
  CreateHomeBoardCategoryRequest,
  UpdateHomeBoardCategoryRequest,
  AssignHomeBoardRequest,
  HomeBoardPreferencesView,
  ApplyWorkflowDraftOperationsRequest,
  WorkflowDetailView,
  WorkflowVersionView,
  UpdateAgentRequest,
  ArtifactView,
  AuditEventView,
  GatewayRequestLogDetail,
  GatewayRequestLogList,
  GatewayRequestLogQuery,
  GatewayTimeRange,
  CreateMcpServerRequest,
  UpdateMcpServerRequest,
  CreateModelProviderRequest,
  UpdateModelProviderRequest,
  DiscoverModelProviderRequest,
  DiscoverModelProviderResult,
  CreateSkillRequest,
  ImportSkillRequest,
  McpServerView,
  McpServerTestResult,
  ModelProviderTestResult,
  SystemOneTestInput,
  TestModelProviderRequest,
  ModelProviderView,
  RunView,
  RunProgressEvent,
  SkillView,
  UpdateSkillRequest,
  UsageRow,
  WorkflowView,
  CommandExecutionEvent,
  AgentExecutionEvent,
  CommandExecutionView,
  ExecuteSkillScriptRequest,
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettingsView,
  PortkeyGatewayView,
  CodexAccountUsageSnapshot,
  CodexAuthStatus,
  CodexRateLimitSnapshot,
  PortkeyGatewayStats,
  PluginView,
  PluginTestResult,
  UpdatePluginRequest,
  WorkflowScheduleView,
  ImportWorkflowRequest,
  PortableWorkflowDocument,
} from '@worklite/contracts';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly requestLogId?: string, public readonly testInput?: SystemOneTestInput) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    let requestLogId: string | undefined;
    let testInput: SystemOneTestInput | undefined;
    try {
      const body = (await response.json()) as { message?: string | string[]; requestLogId?: string; testInput?: SystemOneTestInput };
      if (body.message) message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
      requestLogId = body.requestLogId;
      testInput = body.testInput;
    } catch {
      // Keep the status-based error when the server does not return JSON.
    }
    throw new ApiError(response.status, message, requestLogId, testInput);
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as T;
  const text = await response.text();
  if (!text.trim()) return undefined as T;
  return JSON.parse(text) as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

export function apiPut<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}

export function apiDelete<T = void>(path: string): Promise<T> {
  return apiRequest<T>(path, { method: 'DELETE' });
}

export const api = {
  plugins: () => apiGet<PluginView[]>('/api/plugins'),
  plugin: (pluginId: string) => apiGet<PluginView>(`/api/plugins/${encodeURIComponent(pluginId)}`),
  updatePlugin: (pluginId: string, input: UpdatePluginRequest) => apiPatch<PluginView>(`/api/plugins/${encodeURIComponent(pluginId)}`, input),
  testPlugin: (pluginId: string) => apiPost<PluginTestResult>(`/api/plugins/${encodeURIComponent(pluginId)}/test`),
  startWechatLogin: (pluginId: string) => apiPost<PluginView['wechat']>(`/api/plugins/${encodeURIComponent(pluginId)}/wechat/login`),
  disconnectWechat: (pluginId: string) => apiPost<PluginView['wechat']>(`/api/plugins/${encodeURIComponent(pluginId)}/wechat/disconnect`),
  startOfficialAccountLogin: (pluginId: string) => apiPost<NonNullable<PluginView['officialAccount']>>(`/api/plugins/${encodeURIComponent(pluginId)}/official-account/login`),
  disconnectOfficialAccount: (pluginId: string) => apiPost<NonNullable<PluginView['officialAccount']>>(`/api/plugins/${encodeURIComponent(pluginId)}/official-account/disconnect`),
  command: (commandId: string) => apiGet<CommandExecutionView>(`/api/commands/${encodeURIComponent(commandId)}`),
  cancelCommand: (commandId: string) => apiPost<CommandExecutionView>(`/api/commands/${encodeURIComponent(commandId)}/cancel`),
  commandEventsUrl: (commandId: string) => `/api/commands/${encodeURIComponent(commandId)}/events`,
  agent: (_workspace: string | undefined, agentId: string) => apiGet<AgentView>(`/api/agents/${encodeURIComponent(agentId)}`),
  updateAgent: (_workspace: string | undefined, agentId: string, input: UpdateAgentRequest) => apiPatch<AgentView>(`/api/agents/${encodeURIComponent(agentId)}`, input),
  createAgentExecution: (_workspace: string | undefined, agentId: string, message: string) => apiPost<AgentExecutionView>(`/api/agents/${encodeURIComponent(agentId)}/executions`, { message }),
  agentExecution: (_workspace: string | undefined, agentId: string, executionId: string) => apiGet<AgentExecutionView>(`/api/agents/${encodeURIComponent(agentId)}/executions/${encodeURIComponent(executionId)}`),
  agentExecutionEventsUrl: (agentId: string, executionId: string) => `/api/agents/${encodeURIComponent(agentId)}/executions/${encodeURIComponent(executionId)}/events`,
  continueAgentExecution: (_workspace: string | undefined, agentId: string, executionId: string, message: string) => apiPost<AgentExecutionView>(`/api/agents/${encodeURIComponent(agentId)}/executions/${encodeURIComponent(executionId)}/messages`, { message }),
  retryAgentExecution: (_workspace: string | undefined, agentId: string, executionId: string) => apiPost<AgentExecutionView>(`/api/agents/${encodeURIComponent(agentId)}/executions/${encodeURIComponent(executionId)}/retry`),
  cancelAgentExecution: (_workspace: string | undefined, agentId: string, executionId: string) => apiPost<AgentExecutionView>(`/api/agents/${encodeURIComponent(agentId)}/executions/${encodeURIComponent(executionId)}/cancel`),
  answerAgentQuestion: (_workspace: string | undefined, agentId: string, executionId: string, input: AnswerAgentQuestionRequest) => apiPost<AgentExecutionView>(`/api/agents/${encodeURIComponent(agentId)}/executions/${encodeURIComponent(executionId)}/answers`, input),
  settings: () => apiGet<WorkspaceSettingsView>('/api/settings'),
  updateSettings: (input: UpdateWorkspaceSettingsRequest) => apiPatch<WorkspaceSettingsView>('/api/settings', input),
  portkeyGateway: () => apiGet<PortkeyGatewayView>('/api/portkey-gateway'),
  codexAuthStatus: () => apiGet<CodexAuthStatus>('/api/portkey-gateway/codex/auth/status'),
  codexRateLimits: () => apiGet<CodexRateLimitSnapshot>('/api/portkey-gateway/codex/rate-limits'),
  codexAccountUsages: () => apiGet<CodexAccountUsageSnapshot>('/api/portkey-gateway/codex/accounts/usage'),
  startCodexLogin: () => apiPost<{ authorizationUrl: string; sessionId: string }>('/api/portkey-gateway/codex/auth/login'),
  importCodexAccounts: (input: unknown) => apiPost<CodexAuthStatus>('/api/portkey-gateway/codex/accounts/import', input),
  updateCodexAccount: (accountId: string, enabled: boolean) => apiPatch<CodexAuthStatus>(`/api/portkey-gateway/codex/accounts/${encodeURIComponent(accountId)}`, { enabled }),
  refreshCodexAccount: (accountId: string) => apiPost<CodexAuthStatus>(`/api/portkey-gateway/codex/accounts/${encodeURIComponent(accountId)}/refresh`),
  deleteCodexAccount: (accountId: string) => apiDelete<CodexAuthStatus>(`/api/portkey-gateway/codex/accounts/${encodeURIComponent(accountId)}`),
  portkeyGatewayStats: (range: GatewayTimeRange = {}) => {
    const search = new URLSearchParams();
    if (range.from?.trim()) search.set('from', range.from.trim());
    if (range.to?.trim()) search.set('to', range.to.trim());
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return apiGet<PortkeyGatewayStats>(`/api/portkey-gateway/stats${suffix}`);
  },
  workflows: (_workspace?: string) => apiGet<WorkflowView[]>('/api/workflows'),
  homeBoardPreferences: (_workspace?: string) => apiGet<HomeBoardPreferencesView>('/api/home/board-categories'),
  createHomeBoardCategory: (_workspace: string | undefined, input: CreateHomeBoardCategoryRequest) => apiPost<HomeBoardPreferencesView>('/api/home/board-categories', input),
  renameHomeBoardCategory: (_workspace: string | undefined, categoryId: string, input: UpdateHomeBoardCategoryRequest) => apiPatch<HomeBoardPreferencesView>(`/api/home/board-categories/${encodeURIComponent(categoryId)}`, input),
  deleteHomeBoardCategory: (_workspace: string | undefined, categoryId: string) => apiDelete<HomeBoardPreferencesView>(`/api/home/board-categories/${encodeURIComponent(categoryId)}`),
  assignHomeBoard: (_workspace: string | undefined, input: AssignHomeBoardRequest) => apiPut<HomeBoardPreferencesView>('/api/home/board-assignments', input),
  workflow: (_workspace: string | undefined, workflowId: string) => apiGet<WorkflowDetailView>(`/api/workflows/${encodeURIComponent(workflowId)}`),
  workflowSchedule: async (_workspace: string | undefined, workflowId: string) => (await apiGet<WorkflowScheduleView | null>(`/api/workflows/${encodeURIComponent(workflowId)}/schedule`)) ?? null,
  createWorkflow: (_workspace: string | undefined, input: CreateWorkflowRequest) => apiPost<WorkflowDetailView>('/api/workflows', input),
  importWorkflow: (_workspace: string | undefined, input: ImportWorkflowRequest) => apiPost<WorkflowDetailView>('/api/workflows/import', input),
  exportWorkflow: (_workspace: string | undefined, workflowId: string) => apiGet<PortableWorkflowDocument>(`/api/workflows/${encodeURIComponent(workflowId)}/export`),
  deleteWorkflow: (_workspace: string | undefined, workflowId: string) => apiDelete(`/api/workflows/${encodeURIComponent(workflowId)}`),
  updateWorkflow: (_workspace: string | undefined, workflowId: string, input: Partial<CreateWorkflowRequest>) => apiPatch<WorkflowDetailView>(`/api/workflows/${encodeURIComponent(workflowId)}`, input),
  applyWorkflowOperations: (_workspace: string | undefined, workflowId: string, input: ApplyWorkflowDraftOperationsRequest) => apiPost<WorkflowDetailView>(`/api/workflows/${encodeURIComponent(workflowId)}/draft/operations`, input),
  undoWorkflow: (_workspace: string | undefined, workflowId: string) => apiPost<WorkflowDetailView>(`/api/workflows/${encodeURIComponent(workflowId)}/draft/undo`),
  redoWorkflow: (_workspace: string | undefined, workflowId: string) => apiPost<WorkflowDetailView>(`/api/workflows/${encodeURIComponent(workflowId)}/draft/redo`),
  publishWorkflow: (_workspace: string | undefined, workflowId: string) => apiPost<WorkflowVersionView>(`/api/workflows/${encodeURIComponent(workflowId)}/publish`),
  workflowVersions: (_workspace: string | undefined, workflowId: string) => apiGet<WorkflowVersionView[]>(`/api/workflows/${encodeURIComponent(workflowId)}/versions`),
  workflowVersion: (_workspace: string | undefined, versionId: string) => apiGet<WorkflowVersionView>(`/api/workflow-versions/${encodeURIComponent(versionId)}`),
  skills: (_workspace?: string) => apiGet<SkillView[]>('/api/skills'),
  skill: (_workspace: string | undefined, skillId: string) => apiGet<SkillView>(`/api/skills/${encodeURIComponent(skillId)}`),
  createSkill: (_workspace: string | undefined, input: CreateSkillRequest) => apiPost<SkillView>('/api/skills', input),
  importSkill: (_workspace: string | undefined, input: ImportSkillRequest) => apiPost<SkillView>('/api/skills/import', input),
  updateSkill: (_workspace: string | undefined, skillId: string, input: UpdateSkillRequest) => apiPatch<SkillView>(`/api/skills/${encodeURIComponent(skillId)}`, input),
  deleteSkill: (_workspace: string | undefined, skillId: string) => apiDelete(`/api/skills/${encodeURIComponent(skillId)}`),
  executeSkillScript: (_workspace: string | undefined, skillId: string, input: ExecuteSkillScriptRequest) => apiPost<CommandExecutionView>(`/api/skills/${encodeURIComponent(skillId)}/executions`, input),
  mcpServers: (_workspace?: string) => apiGet<McpServerView[]>('/api/mcp-servers'),
  mcpServer: (_workspace: string | undefined, serverId: string) => apiGet<McpServerView>(`/api/mcp-servers/${encodeURIComponent(serverId)}`),
  createMcpServer: (_workspace: string | undefined, input: CreateMcpServerRequest) => apiPost<McpServerView>('/api/mcp-servers', input),
  updateMcpServer: (_workspace: string | undefined, serverId: string, input: UpdateMcpServerRequest) => apiPatch<McpServerView>(`/api/mcp-servers/${encodeURIComponent(serverId)}`, input),
  deleteMcpServer: (_workspace: string | undefined, serverId: string) => apiDelete(`/api/mcp-servers/${encodeURIComponent(serverId)}`),
  testMcpServer: (_workspace: string | undefined, serverId: string) => apiPost<McpServerTestResult>(`/api/mcp-servers/${encodeURIComponent(serverId)}/test`),
  modelProviders: (_workspace?: string) => apiGet<ModelProviderView[]>('/api/portkey-gateway/providers'),
  saveModelProvider: (_workspace: string | undefined, input: CreateModelProviderRequest) => apiPost<ModelProviderView>('/api/portkey-gateway/providers', input),
  updateModelProvider: (_workspace: string | undefined, providerId: string, input: UpdateModelProviderRequest) => apiPatch<ModelProviderView>(`/api/portkey-gateway/providers/${encodeURIComponent(providerId)}`, input),
  discoverModelProviderModels: (input: DiscoverModelProviderRequest) => apiPost<DiscoverModelProviderResult>('/api/portkey-gateway/model-providers/discover-models', input),
  testModelProvider: (_workspace: string | undefined, providerId: string, input: TestModelProviderRequest) => apiPost<ModelProviderTestResult>(`/api/portkey-gateway/providers/${encodeURIComponent(providerId)}/test`, input),
  deleteModelProvider: (_workspace: string | undefined, providerId: string) => apiDelete(`/api/portkey-gateway/providers/${encodeURIComponent(providerId)}`),
  artifacts: (_workspace?: string) => apiGet<ArtifactView[]>('/api/artifacts'),
  artifact: (_workspace: string | undefined, artifactId: string) => apiGet<ArtifactView>(`/api/artifacts/${encodeURIComponent(artifactId)}`),
  deleteArtifact: (_workspace: string | undefined, artifactId: string) => apiDelete(`/api/artifacts/${encodeURIComponent(artifactId)}`),
  usage: (_workspace?: string) => apiGet<UsageRow[]>('/api/usage'),
  auditLogs: (_workspace?: string) => apiGet<AuditEventView[]>('/api/audit-logs'),
  gatewayRequestLogs: (query: GatewayRequestLogQuery = {}) => {
    const search = new URLSearchParams();
    if (query.from?.trim()) search.set('from', query.from.trim());
    if (query.to?.trim()) search.set('to', query.to.trim());
    if (query.provider?.trim()) search.set('provider', query.provider.trim());
    if (query.model?.trim()) search.set('model', query.model.trim());
    if (query.statusClass) search.set('statusClass', query.statusClass);
    if (query.workflowRunId?.trim()) search.set('workflowRunId', query.workflowRunId.trim());
    if (query.teamRunId?.trim()) search.set('teamRunId', query.teamRunId.trim());
    if (query.limit) search.set('limit', String(query.limit));
    if (query.cursor?.trim()) search.set('cursor', query.cursor.trim());
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return apiGet<GatewayRequestLogList>(`/api/portkey-gateway/request-logs${suffix}`);
  },
  gatewayRequestLog: (requestLogId: string) => apiGet<GatewayRequestLogDetail>(`/api/portkey-gateway/request-logs/${encodeURIComponent(requestLogId)}`),
  agentTeams: () => apiGet<AgentTeamView[]>('/api/agent-teams'),
  agentTeam: (teamId: string) => apiGet<AgentTeamView>(`/api/agent-teams/${encodeURIComponent(teamId)}`),
  updateAgentTeam: (teamId: string, input: UpdateAgentTeamRequest) => apiPatch<AgentTeamView>(`/api/agent-teams/${encodeURIComponent(teamId)}`, input),
  createAgentTeamRun: (teamId: string, input: CreateAgentTeamRunRequest) => apiPost<CreateAgentTeamRunResponse>(`/api/agent-teams/${encodeURIComponent(teamId)}/runs`, input),
  agentTeamRun: (runId: string) => apiGet<AgentTeamRunView>(`/api/agent-team-runs/${encodeURIComponent(runId)}`),
  agentTeamRunEventsUrl: (runId: string) => `/api/agent-team-runs/${encodeURIComponent(runId)}/events`,
  answerAgentTeamRun: (runId: string, input: AnswerAgentTeamRunRequest) => apiPost<AgentTeamRunActionResponse>(`/api/agent-team-runs/${encodeURIComponent(runId)}/answer`, input),
  recoverAgentTeamOperation: (runId: string, operationKey: string, input: RecoverAgentTeamOperationRequest) => apiPost<AgentTeamRunActionResponse>(`/api/agent-team-runs/${encodeURIComponent(runId)}/operations/${encodeURIComponent(operationKey)}/recovery`, input),
  pauseAgentTeamRun: (runId: string) => apiPost<AgentTeamRunActionResponse>(`/api/agent-team-runs/${encodeURIComponent(runId)}/pause`),
  resumeAgentTeamRun: (runId: string) => apiPost<AgentTeamRunActionResponse>(`/api/agent-team-runs/${encodeURIComponent(runId)}/resume`),
  cancelAgentTeamRun: (runId: string) => apiPost<AgentTeamRunActionResponse>(`/api/agent-team-runs/${encodeURIComponent(runId)}/cancel`),
  retryAgentTeamTask: (runId: string, taskKey: string) => apiPost<AgentTeamRunActionResponse>(`/api/agent-team-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskKey)}/retry`),
  runs: (_workspace?: string) => apiGet<RunView[]>('/api/runs'),
  run: (_workspace: string | undefined, runId: string) => apiGet<RunView>(`/api/runs/${encodeURIComponent(runId)}`),
  runEventsUrl: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/events`,
  createRun: (workflowVersionId: string, input: CreateRunRequest) => apiPost<{ runId: string }>(`/api/workflow-versions/${encodeURIComponent(workflowVersionId)}/runs`, input),
  cancelRun: (_workspace: string | undefined, runId: string) => apiPost<RunView>(`/api/runs/${encodeURIComponent(runId)}/cancel`),
  pauseRun: (_workspace: string | undefined, runId: string) => apiPost<RunView>(`/api/runs/${encodeURIComponent(runId)}/pause`),
  resumeRun: (_workspace: string | undefined, runId: string) => apiPost<RunView>(`/api/runs/${encodeURIComponent(runId)}/resume`),
  refreshRunPendingAction: (_workspace: string | undefined, runId: string) => apiPost<RunView>(`/api/runs/${encodeURIComponent(runId)}/pending-action/refresh`),
  retryRunNode: (_workspace: string | undefined, runId: string, nodeRunId: string) => apiPost<RunView>(`/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeRunId)}/retry`),
};

export function parseCommandEvent(value: string): CommandExecutionEvent {
  const event = JSON.parse(value) as Partial<CommandExecutionEvent>;
  if (
    typeof event.sequence !== 'number'
    || typeof event.commandId !== 'string'
    || (event.type !== 'stdout' && event.type !== 'stderr' && event.type !== 'lifecycle')
    || typeof event.data !== 'string'
    || typeof event.createdAt !== 'string'
  ) {
    throw new Error('The command event stream returned an invalid event.');
  }
  return event as CommandExecutionEvent;
}

export function parseAgentExecutionEvent(value: string): AgentExecutionEvent {
  const event = JSON.parse(value) as Partial<AgentExecutionEvent>;
  if (typeof event.sequence !== 'number' || typeof event.executionId !== 'string' || !event.data || typeof event.data !== 'object' || typeof event.createdAt !== 'string') {
    throw new Error('The Agent event stream returned an invalid event.');
  }
  return event as AgentExecutionEvent;
}

export function parseRunProgressEvent(value: string): RunProgressEvent {
  const event = JSON.parse(value) as Partial<RunProgressEvent>;
  if (
    typeof event.runId !== 'string'
    || typeof event.sequence !== 'number'
    || typeof event.type !== 'string'
    || typeof event.occurredAt !== 'string'
  ) {
    throw new Error('The workflow run event stream returned an invalid event.');
  }
  return event as RunProgressEvent;
}

export function parseAgentTeamRunEvent(value: string): AgentTeamRunEvent {
  const event = JSON.parse(value) as Partial<AgentTeamRunEvent>;
  if (
    typeof event.runId !== 'string'
    || typeof event.sequence !== 'number'
    || typeof event.type !== 'string'
    || !event.payload
    || typeof event.payload !== 'object'
    || typeof event.createdAt !== 'string'
  ) {
    throw new Error('The Agent Team run event stream returned an invalid event.');
  }
  return event as AgentTeamRunEvent;
}
