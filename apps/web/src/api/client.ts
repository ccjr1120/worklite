import type {
  AgentView,
  AgentTeamDocumentView,
  AgentTeamMemoryView,
  AgentTeamRunView,
  AgentTeamRunSummary,
  AgentTeamRunListPage,
  AgentTeamRunNodeTree,
  AgentTeamRunEvent,
  AgentTeamView,
  AgentTeamRoleConfiguration,
  UpdateAgentTeamRequest,
  AnswerAgentTeamRunRequest,
  RecoverAgentTeamOperationRequest,
  AgentTeamRunActionResponse,
  AgentTeamGroupView,
  AgentExecutionView,
  AnswerAgentQuestionRequest,
  ChatProjectOperationDetailView,
  ChatProjectTaskView,
  SteerProjectTaskRequest,
  ChatMemoryList,
  ChatMemoryView,
  UpdateChatMemoryRequest,
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
  ArtifactDetailView,
  ArtifactListPageView,
  ArtifactListQuery,
  AuditEventView,
  GatewayRequestLogDetail,
  GatewayRequestLogList,
  GatewayAttributionFilters,
  GatewayRequestLogQuery,
  PortkeyGatewayStatsQuery,
  CreateMcpServerRequest,
  DeleteMcpServerResult,
  McpServerReferenceReport,
  UpdateMcpServerRequest,
  CreateModelProviderRequest,
  UpdateModelProviderRequest,
  DiscoverModelProviderRequest,
  DiscoverModelProviderResult,
  ImportSkillRequest,
  McpServerView,
  McpServerTestResult,
  ModelProviderTestResult,
  SystemOneTestInput,
  TestModelProviderRequest,
  ModelProviderView,
  RunView,
  SkillView,
  DeleteSkillResult,
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
  PortkeyGatewayStats,
  PluginView,
  PluginTestResult,
  UpdatePluginRequest,
  DispatchChatRequest,
  DispatchChatResponse,
  ChatChannelView,
  ChatConversationList,
  ChatConversationView,
  ChatConversationRecords,
  SummarizeChatConversationResponse,
  ChatAttachmentView,
  WorkliteUpgradeView,
  WorkflowScheduleView,
  ImportWorkflowRequest,
  PortableWorkflowDocument,
} from '@worklite/contracts';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly requestLogId?: string, public readonly testInput?: SystemOneTestInput, public readonly references?: McpServerReferenceReport, public readonly code?: string) {
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
    let references: McpServerReferenceReport | undefined;
    let code: string | undefined;
    try {
      const body = (await response.json()) as { message?: string | string[]; requestLogId?: string; testInput?: SystemOneTestInput; references?: McpServerReferenceReport; code?: string };
      if (body.message) message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
      requestLogId = body.requestLogId;
      testInput = body.testInput;
      references = body.references;
      code = typeof body.code === 'string' ? body.code : undefined;
    } catch {
      // Keep the status-based error when the server does not return JSON.
    }
    throw new ApiError(response.status, message, requestLogId, testInput, references, code);
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as T;
  const text = await response.text();
  if (!text.trim()) return undefined as T;
  return JSON.parse(text) as T;
}

// Attribution filters are spelled the same way on statistics and on request details,
// so a view can move one question between the two without rewriting it.
function appendGatewayAttribution(search: URLSearchParams, filters: GatewayAttributionFilters): void {
  const entries: Array<[string, string | undefined]> = [
    ['surface', filters.surface],
    ['conversationId', filters.conversationId],
    ['projectTaskId', filters.projectTaskId],
    ['executor', filters.executor],
    ['coderId', filters.coderId],
    ['teamRunId', filters.teamRunId],
    ['workflowId', filters.workflowId],
    ['workflowRunId', filters.workflowRunId],
    ['nodeRunId', filters.nodeRunId],
  ];
  for (const [name, value] of entries) {
    const trimmed = value?.trim();
    if (trimmed) search.set(name, trimmed);
  }
}

function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path);
}

function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}

function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

function apiPut<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}

function apiDelete<T = void>(path: string): Promise<T> {
  return apiRequest<T>(path, { method: 'DELETE' });
}

export const api = {
  plugins: () => apiGet<PluginView[]>('/api/plugins'),
  plugin: (pluginId: string) => apiGet<PluginView>(`/api/plugins/${encodeURIComponent(pluginId)}`),
  updatePlugin: (pluginId: string, input: UpdatePluginRequest) => apiPatch<PluginView>(`/api/plugins/${encodeURIComponent(pluginId)}`, input),
  testPlugin: (pluginId: string) => apiPost<PluginTestResult>(`/api/plugins/${encodeURIComponent(pluginId)}/test`),
  disconnectFeishu: () => apiPost<PluginView>('/api/plugins/feishu-bot/feishu/disconnect'),
  startFeishuRegistration: () => apiPost<NonNullable<NonNullable<PluginView['feishu']>['registration']>>('/api/plugins/feishu-bot/feishu/registration'),
  cancelFeishuRegistration: () => apiDelete<PluginView>('/api/plugins/feishu-bot/feishu/registration'),
  dispatchChat: (input: DispatchChatRequest) => apiPost<DispatchChatResponse>('/api/chat/dispatch', input),
  chatChannels: () => apiGet<ChatChannelView[]>('/api/chat/channels'),
  chatConversations: (query: { cursor?: string; search?: string; channel?: string } = {}) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value) search.set(key, value);
    return apiGet<ChatConversationList>(`/api/chat/conversations${search.size ? `?${search}` : ''}`);
  },
  chatConversation: (id: string) => apiGet<ChatConversationView>(`/api/chat/conversations/${encodeURIComponent(id)}`),
  chatConversationRecords: (id: string) => apiGet<ChatConversationRecords>(`/api/chat/conversations/${encodeURIComponent(id)}/records`),
  summarizeChatConversation: (id: string) => apiPost<SummarizeChatConversationResponse>(`/api/chat/conversations/${encodeURIComponent(id)}/summarize`),
  chatProjectTask: (taskId: string, activities?: 'full') => apiGet<ChatProjectTaskView>(`/api/chat/project-tasks/${encodeURIComponent(taskId)}${activities === 'full' ? '?activities=full' : ''}`),
  chatProjectOperation: (taskId: string, operationKey: string) => apiGet<ChatProjectOperationDetailView>(`/api/chat/project-tasks/${encodeURIComponent(taskId)}?operationKey=${encodeURIComponent(operationKey)}`),
  answerChatProjectTask: (taskId: string, input: AnswerAgentQuestionRequest) => apiPost<ChatProjectTaskView>(`/api/chat/project-tasks/${encodeURIComponent(taskId)}/answer`, input),
  cancelChatProjectTask: (taskId: string) => apiPost<ChatProjectTaskView>(`/api/chat/project-tasks/${encodeURIComponent(taskId)}/cancel`),
  steerChatProjectTask: (taskId: string, input: SteerProjectTaskRequest) => apiPost<ChatProjectTaskView>(`/api/chat/project-tasks/${encodeURIComponent(taskId)}/steer`, input),
  // Inbound composer images use the same attachment store as executor-produced report images: the
  // raw bytes are the request body and the returned Markdown is what the message carries.
  uploadChatAttachment: (file: Blob, options: { fileName: string; conversationId?: string | null }) => {
    const search = new URLSearchParams({ fileName: options.fileName });
    if (options.conversationId) search.set('conversationId', options.conversationId);
    return apiRequest<ChatAttachmentView>(`/api/chat/attachments?${search}`, { method: 'POST', body: file, headers: { 'Content-Type': file.type } });
  },
  deleteChatAttachment: (id: string) => apiDelete(`/api/chat/attachments/${encodeURIComponent(id)}`),
  chatMemories: () => apiGet<ChatMemoryList>('/api/chat/memories'),
  updateChatMemory: (memoryId: string, input: UpdateChatMemoryRequest) => apiPatch<ChatMemoryView>(`/api/chat/memories/${encodeURIComponent(memoryId)}`, input),
  deleteChatMemory: (memoryId: string) => apiDelete(`/api/chat/memories/${encodeURIComponent(memoryId)}`),
  workliteUpgrade: (id: string) => apiGet<WorkliteUpgradeView>(`/api/upgrades/${encodeURIComponent(id)}`),
  startOfficialAccountLogin: (pluginId: string) => apiPost<NonNullable<PluginView['officialAccount']>>(`/api/plugins/${encodeURIComponent(pluginId)}/official-account/login`),
  disconnectOfficialAccount: (pluginId: string) => apiPost<NonNullable<PluginView['officialAccount']>>(`/api/plugins/${encodeURIComponent(pluginId)}/official-account/disconnect`),
  startWechatLogin: (pluginId: string) => apiPost<NonNullable<NonNullable<PluginView['wechat']>['login']>>(`/api/plugins/${encodeURIComponent(pluginId)}/wechat/login`),
  cancelWechatLogin: (pluginId: string) => apiDelete<PluginView>(`/api/plugins/${encodeURIComponent(pluginId)}/wechat/login`),
  disconnectWechat: (pluginId: string) => apiPost<PluginView>(`/api/plugins/${encodeURIComponent(pluginId)}/wechat/disconnect`),
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
  codexAccountUsages: () => apiGet<CodexAccountUsageSnapshot>('/api/portkey-gateway/codex/accounts/usage'),
  startCodexLogin: () => apiPost<{ authorizationUrl: string; sessionId: string }>('/api/portkey-gateway/codex/auth/login'),
  importCodexAccounts: (input: unknown) => apiPost<CodexAuthStatus>('/api/portkey-gateway/codex/accounts/import', input),
  updateCodexAccount: (accountId: string, enabled: boolean) => apiPatch<CodexAuthStatus>(`/api/portkey-gateway/codex/accounts/${encodeURIComponent(accountId)}`, { enabled }),
  refreshCodexAccount: (accountId: string) => apiPost<CodexAuthStatus>(`/api/portkey-gateway/codex/accounts/${encodeURIComponent(accountId)}/refresh`),
  deleteCodexAccount: (accountId: string) => apiDelete<CodexAuthStatus>(`/api/portkey-gateway/codex/accounts/${encodeURIComponent(accountId)}`),
  portkeyGatewayStats: (query: PortkeyGatewayStatsQuery = {}) => {
    const search = new URLSearchParams();
    if (query.from?.trim()) search.set('from', query.from.trim());
    if (query.to?.trim()) search.set('to', query.to.trim());
    if (query.groupBy) search.set('groupBy', query.groupBy);
    appendGatewayAttribution(search, query);
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
  importSkill: (_workspace: string | undefined, input: ImportSkillRequest) => apiPost<SkillView>('/api/skills/import', input),
  deleteSkill: (_workspace: string | undefined, skillId: string) => apiDelete<DeleteSkillResult>(`/api/skills/${encodeURIComponent(skillId)}`),
  executeSkillScript: (_workspace: string | undefined, skillId: string, input: ExecuteSkillScriptRequest) => apiPost<CommandExecutionView>(`/api/skills/${encodeURIComponent(skillId)}/executions`, input),
  mcpServers: (_workspace?: string) => apiGet<McpServerView[]>('/api/mcp-servers'),
  mcpServer: (_workspace: string | undefined, serverId: string) => apiGet<McpServerView>(`/api/mcp-servers/${encodeURIComponent(serverId)}`),
  createMcpServer: (_workspace: string | undefined, input: CreateMcpServerRequest) => apiPost<McpServerView>('/api/mcp-servers', input),
  updateMcpServer: (_workspace: string | undefined, serverId: string, input: UpdateMcpServerRequest) => apiPatch<McpServerView>(`/api/mcp-servers/${encodeURIComponent(serverId)}`, input),
  deleteMcpServer: (_workspace: string | undefined, serverId: string, options: { force?: boolean } = {}) => apiDelete<DeleteMcpServerResult>(`/api/mcp-servers/${encodeURIComponent(serverId)}${options.force ? '?force=true' : ''}`),
  testMcpServer: (_workspace: string | undefined, serverId: string) => apiPost<McpServerTestResult>(`/api/mcp-servers/${encodeURIComponent(serverId)}/test`),
  modelProviders: (_workspace?: string) => apiGet<ModelProviderView[]>('/api/portkey-gateway/providers'),
  saveModelProvider: (_workspace: string | undefined, input: CreateModelProviderRequest) => apiPost<ModelProviderView>('/api/portkey-gateway/providers', input),
  updateModelProvider: (_workspace: string | undefined, providerId: string, input: UpdateModelProviderRequest) => apiPatch<ModelProviderView>(`/api/portkey-gateway/providers/${encodeURIComponent(providerId)}`, input),
  discoverModelProviderModels: (input: DiscoverModelProviderRequest) => apiPost<DiscoverModelProviderResult>('/api/portkey-gateway/model-providers/discover-models', input),
  testModelProvider: (_workspace: string | undefined, providerId: string, input: TestModelProviderRequest) => apiPost<ModelProviderTestResult>(`/api/portkey-gateway/providers/${encodeURIComponent(providerId)}/test`, input),
  deleteModelProvider: (_workspace: string | undefined, providerId: string) => apiDelete(`/api/portkey-gateway/providers/${encodeURIComponent(providerId)}`),
  artifacts: (_workspace: string | undefined, query: ArtifactListQuery = {}) => {
    const search = new URLSearchParams();
    if (query.search?.trim()) search.set('search', query.search.trim());
    if (query.workflowId?.trim()) search.set('workflowId', query.workflowId.trim());
    if (query.page) search.set('page', String(query.page));
    if (query.pageSize) search.set('pageSize', String(query.pageSize));
    return apiGet<ArtifactListPageView>(`/api/artifacts${search.size > 0 ? `?${search.toString()}` : ''}`);
  },
  artifact: (_workspace: string | undefined, artifactId: string) => apiGet<ArtifactDetailView>(`/api/artifacts/${encodeURIComponent(artifactId)}`),
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
    appendGatewayAttribution(search, query);
    if (query.limit) search.set('limit', String(query.limit));
    if (query.cursor?.trim()) search.set('cursor', query.cursor.trim());
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return apiGet<GatewayRequestLogList>(`/api/portkey-gateway/request-logs${suffix}`);
  },
  gatewayRequestLog: (requestLogId: string) => apiGet<GatewayRequestLogDetail>(`/api/portkey-gateway/request-logs/${encodeURIComponent(requestLogId)}`),
  executors: () => apiGet<AgentTeamView[]>('/api/coders'),
  coderRecords: (coderId: string) => apiGet<AgentTeamRunSummary[]>(`/api/coders/${encodeURIComponent(coderId)}/runs`),
  agentTeamRunList: (query: { coderIds?: string[]; cursor?: string; limit?: number }) => {
    const search = new URLSearchParams();
    if (query.coderIds?.length) {
      query.coderIds.forEach(id => search.append('coderId', id));
    }
    if (query.cursor?.trim()) search.set('cursor', query.cursor.trim());
    if (query.limit) search.set('limit', String(query.limit));
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return apiGet<AgentTeamRunListPage>(`/api/coder-runs${suffix}`);
  },
  agentTeamRunNodes: (runIds: string[]) => apiGet<AgentTeamRunNodeTree>(`/api/coder-runs/nodes?runIds=${encodeURIComponent(runIds.join(','))}`),
  executor: (coderId: string) => apiGet<AgentTeamView>(`/api/coders/${encodeURIComponent(coderId)}`),
  updateCoder: (coderId: string, input: UpdateAgentTeamRequest) => apiPatch<AgentTeamView>(`/api/coders/${encodeURIComponent(coderId)}`, input),
  updateCoderRole: (coderId: string, roleId: string, input: Partial<Omit<AgentTeamRoleConfiguration, 'role'>>) =>
    apiPatch<AgentTeamView>(`/api/coders/${encodeURIComponent(coderId)}/roles/${encodeURIComponent(roleId)}`, input),
  coderMemories: (coderId: string) => apiGet<AgentTeamMemoryView[]>(`/api/coders/${encodeURIComponent(coderId)}/memories`),
  agentTeamGroup: (groupId: string) => apiGet<AgentTeamGroupView>(`/api/coder-groups/${encodeURIComponent(groupId)}`),
  controlAgentTeamGroup: (groupId: string, input: { operation: 'reexecute'; runIds: string[] }) => apiPost<AgentTeamGroupView>(`/api/coder-groups/${encodeURIComponent(groupId)}/controls`, input),
  coderGroupEventsUrl: (groupId: string) => `/api/coder-groups/${encodeURIComponent(groupId)}/events`,
  coderDocument: (documentId: string) => apiGet<AgentTeamDocumentView>(`/api/coder-documents/${encodeURIComponent(documentId)}`),
  downloadCoderDocument: async (documentId: string): Promise<Blob> => {
    const response = await fetch(`/api/coder-documents/${encodeURIComponent(documentId)}/download`, {
      credentials: 'include',
    });
    if (!response.ok) {
      throw new ApiError(response.status, `Request failed: ${response.status}`);
    }
    return response.blob();
  },
  agentTeamRun: (runId: string) => apiGet<AgentTeamRunView>(`/api/coder-runs/${encodeURIComponent(runId)}`),
  coderRunEventsUrl: (runId: string) => `/api/coder-runs/${encodeURIComponent(runId)}/events`,
  answerAgentTeamRun: (runId: string, input: AnswerAgentTeamRunRequest) => apiPost<AgentTeamRunActionResponse>(`/api/coder-runs/${encodeURIComponent(runId)}/answer`, input),
  recoverAgentTeamOperation: (runId: string, operationKey: string, input: RecoverAgentTeamOperationRequest) => apiPost<AgentTeamRunActionResponse>(`/api/coder-runs/${encodeURIComponent(runId)}/operations/${encodeURIComponent(operationKey)}/recovery`, input),
  pauseAgentTeamRun: (runId: string) => apiPost<AgentTeamRunActionResponse>(`/api/coder-runs/${encodeURIComponent(runId)}/pause`),
  resumeAgentTeamRun: (runId: string) => apiPost<AgentTeamRunActionResponse>(`/api/coder-runs/${encodeURIComponent(runId)}/resume`),
  cancelAgentTeamRun: (runId: string) => apiPost<AgentTeamRunActionResponse>(`/api/coder-runs/${encodeURIComponent(runId)}/cancel`),
  retryAgentTeamTask: (runId: string, taskKey: string) => apiPost<AgentTeamRunActionResponse>(`/api/coder-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskKey)}/retry`),
  runs: (_workspace?: string) => apiGet<RunView[]>('/api/runs'),
  run: (_workspace: string | undefined, runId: string) => apiGet<RunView>(`/api/runs/${encodeURIComponent(runId)}`),
  runEventsUrl: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/events`,
  createRun: (workflowVersionId: string, input: CreateRunRequest) => apiPost<{ runId: string }>(`/api/workflow-versions/${encodeURIComponent(workflowVersionId)}/runs`, input),
  cancelRun: (_workspace: string | undefined, runId: string) => apiPost<RunView>(`/api/runs/${encodeURIComponent(runId)}/cancel`),
  pauseRun: (_workspace: string | undefined, runId: string) => apiPost<RunView>(`/api/runs/${encodeURIComponent(runId)}/pause`),
  resumeRun: (_workspace: string | undefined, runId: string) => apiPost<RunView>(`/api/runs/${encodeURIComponent(runId)}/resume`),
  refreshRunPendingAction: (_workspace: string | undefined, runId: string) => apiPost<RunView>(`/api/runs/${encodeURIComponent(runId)}/pending-action/refresh`),
  openRunPendingActionBrowser: (_workspace: string | undefined, runId: string) => apiPost<RunView>(`/api/runs/${encodeURIComponent(runId)}/pending-action/open-browser`),
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
    throw new Error('The Coder Run event stream returned an invalid event.');
  }
  return event as AgentTeamRunEvent;
}

