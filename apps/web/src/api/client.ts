import type {
  AgentView,
  AgentVersionView,
  AgentExecutionView,
  AnswerAgentQuestionRequest,
  AgentSubSessionView,
  ScheduledAgentTaskView,
  CreateScheduledAgentTaskRequest,
  CreateAgentSubSessionRequest,
  CreateAgentRequest,
  CreateRunRequest,
  CreateWorkflowRequest,
  ApplyWorkflowDraftOperationsRequest,
  WorkflowDetailView,
  WorkflowVersionView,
  UpdateAgentRequest,
  ArtifactView,
  AuditEventView,
  CreateMcpServerRequest,
  UpdateMcpServerRequest,
  CreateModelProviderRequest,
  CreateSkillRequest,
  McpServerView,
  McpServerTestResult,
  ModelProviderTestResult,
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
  PluginView,
  PluginTestResult,
  UpdatePluginRequest,
} from '@worklite/contracts';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
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
    try {
      const body = (await response.json()) as { message?: string | string[] };
      if (body.message) message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    } catch {
      // Keep the status-based error when the server does not return JSON.
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
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
  command: (commandId: string) => apiGet<CommandExecutionView>(`/api/commands/${encodeURIComponent(commandId)}`),
  cancelCommand: (commandId: string) => apiPost<CommandExecutionView>(`/api/commands/${encodeURIComponent(commandId)}/cancel`),
  commandEventsUrl: (commandId: string) => `/api/commands/${encodeURIComponent(commandId)}/events`,
  agents: (_workspace?: string) => apiGet<AgentView[]>('/api/agents'),
  agent: (_workspace: string | undefined, agentId: string) => apiGet<AgentView>(`/api/agents/${encodeURIComponent(agentId)}`),
  agentVersions: (_workspace: string | undefined, agentId: string) => apiGet<AgentVersionView[]>(`/api/agents/${encodeURIComponent(agentId)}/versions`),
  agentVersion: (_workspace: string | undefined, versionId: string) => apiGet<AgentVersionView>(`/api/agent-versions/${encodeURIComponent(versionId)}`),
  createAgentVersion: (_workspace: string | undefined, agentId: string) => apiPost<AgentVersionView>(`/api/agents/${encodeURIComponent(agentId)}/versions`),
  createAgent: (_workspace: string | undefined, input: CreateAgentRequest) => apiPost<AgentView>('/api/agents', input),
  updateAgent: (_workspace: string | undefined, agentId: string, input: UpdateAgentRequest) => apiPatch<AgentView>(`/api/agents/${encodeURIComponent(agentId)}`, input),
  deleteAgent: (_workspace: string | undefined, agentId: string) => apiDelete(`/api/agents/${encodeURIComponent(agentId)}`),
  agentSubSessions: (_workspace?: string) => apiGet<AgentSubSessionView[]>('/api/agent-sub-sessions'),
  createAgentSubSession: (_workspace: string | undefined, input: CreateAgentSubSessionRequest) => apiPost<AgentSubSessionView>('/api/agent-sub-sessions', input),
  updateAgentSubSession: (_workspace: string | undefined, sessionId: string, unread: boolean) => apiPatch<AgentSubSessionView>(`/api/agent-sub-sessions/${encodeURIComponent(sessionId)}`, { unread }),
  deleteAgentSubSession: (_workspace: string | undefined, sessionId: string) => apiDelete(`/api/agent-sub-sessions/${encodeURIComponent(sessionId)}`),
  agentScheduledTasks: (_workspace?: string) => apiGet<ScheduledAgentTaskView[]>('/api/agent-scheduled-tasks'),
  createAgentScheduledTask: (_workspace: string | undefined, input: CreateScheduledAgentTaskRequest) => apiPost<ScheduledAgentTaskView>('/api/agent-scheduled-tasks', input),
  deleteAgentScheduledTask: (_workspace: string | undefined, taskId: string) => apiDelete(`/api/agent-scheduled-tasks/${encodeURIComponent(taskId)}`),
  createAgentExecution: (_workspace: string | undefined, agentId: string, message: string) => apiPost<AgentExecutionView>(`/api/agents/${encodeURIComponent(agentId)}/executions`, { message }),
  agentExecution: (_workspace: string | undefined, agentId: string, executionId: string) => apiGet<AgentExecutionView>(`/api/agents/${encodeURIComponent(agentId)}/executions/${encodeURIComponent(executionId)}`),
  agentExecutionEventsUrl: (agentId: string, executionId: string) => `/api/agents/${encodeURIComponent(agentId)}/executions/${encodeURIComponent(executionId)}/events`,
  continueAgentExecution: (_workspace: string | undefined, agentId: string, executionId: string, message: string) => apiPost<AgentExecutionView>(`/api/agents/${encodeURIComponent(agentId)}/executions/${encodeURIComponent(executionId)}/messages`, { message }),
  retryAgentExecution: (_workspace: string | undefined, agentId: string, executionId: string) => apiPost<AgentExecutionView>(`/api/agents/${encodeURIComponent(agentId)}/executions/${encodeURIComponent(executionId)}/retry`),
  cancelAgentExecution: (_workspace: string | undefined, agentId: string, executionId: string) => apiPost<AgentExecutionView>(`/api/agents/${encodeURIComponent(agentId)}/executions/${encodeURIComponent(executionId)}/cancel`),
  answerAgentQuestion: (_workspace: string | undefined, agentId: string, executionId: string, input: AnswerAgentQuestionRequest) => apiPost<AgentExecutionView>(`/api/agents/${encodeURIComponent(agentId)}/executions/${encodeURIComponent(executionId)}/answers`, input),
  settings: () => apiGet<WorkspaceSettingsView>('/api/settings'),
  updateSettings: (input: UpdateWorkspaceSettingsRequest) => apiPatch<WorkspaceSettingsView>('/api/settings', input),
  workflows: (_workspace?: string) => apiGet<WorkflowView[]>('/api/workflows'),
  workflow: (_workspace: string | undefined, workflowId: string) => apiGet<WorkflowDetailView>(`/api/workflows/${encodeURIComponent(workflowId)}`),
  createWorkflow: (_workspace: string | undefined, input: CreateWorkflowRequest) => apiPost<WorkflowDetailView>('/api/workflows', input),
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
  updateSkill: (_workspace: string | undefined, skillId: string, input: UpdateSkillRequest) => apiPatch<SkillView>(`/api/skills/${encodeURIComponent(skillId)}`, input),
  executeSkillScript: (_workspace: string | undefined, skillId: string, input: ExecuteSkillScriptRequest) => apiPost<CommandExecutionView>(`/api/skills/${encodeURIComponent(skillId)}/executions`, input),
  mcpServers: (_workspace?: string) => apiGet<McpServerView[]>('/api/mcp-servers'),
  mcpServer: (_workspace: string | undefined, serverId: string) => apiGet<McpServerView>(`/api/mcp-servers/${encodeURIComponent(serverId)}`),
  createMcpServer: (_workspace: string | undefined, input: CreateMcpServerRequest) => apiPost<McpServerView>('/api/mcp-servers', input),
  updateMcpServer: (_workspace: string | undefined, serverId: string, input: UpdateMcpServerRequest) => apiPatch<McpServerView>(`/api/mcp-servers/${encodeURIComponent(serverId)}`, input),
  testMcpServer: (_workspace: string | undefined, serverId: string) => apiPost<McpServerTestResult>(`/api/mcp-servers/${encodeURIComponent(serverId)}/test`),
  modelProviders: (_workspace?: string) => apiGet<ModelProviderView[]>('/api/model-providers'),
  saveModelProvider: (_workspace: string | undefined, input: CreateModelProviderRequest) => apiPost<ModelProviderView>('/api/model-providers', input),
  testModelProvider: (_workspace: string | undefined, providerId: string) => apiPost<ModelProviderTestResult>(`/api/model-providers/${encodeURIComponent(providerId)}/test`),
  deleteModelProvider: (_workspace: string | undefined, providerId: string) => apiDelete(`/api/model-providers/${encodeURIComponent(providerId)}`),
  artifacts: (_workspace?: string) => apiGet<ArtifactView[]>('/api/artifacts'),
  artifact: (_workspace: string | undefined, artifactId: string) => apiGet<ArtifactView>(`/api/artifacts/${encodeURIComponent(artifactId)}`),
  usage: (_workspace?: string) => apiGet<UsageRow[]>('/api/usage'),
  auditLogs: (_workspace?: string) => apiGet<AuditEventView[]>('/api/audit-logs'),
  runs: (_workspace?: string) => apiGet<RunView[]>('/api/runs'),
  run: (_workspace: string | undefined, runId: string) => apiGet<RunView>(`/api/runs/${encodeURIComponent(runId)}`),
  runEventsUrl: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/events`,
  createRun: (workflowVersionId: string, input: CreateRunRequest) => apiPost<{ runId: string }>(`/api/workflow-versions/${encodeURIComponent(workflowVersionId)}/runs`, input),
  cancelRun: (_workspace: string | undefined, runId: string) => apiPost<RunView>(`/api/runs/${encodeURIComponent(runId)}/cancel`),
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
