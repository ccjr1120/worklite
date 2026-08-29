import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export const agentsQueryKey = () => ['agents'] as const;
export const agentSubSessionsQueryKey = () => ['agent-sub-sessions'] as const;
export const agentScheduledTasksQueryKey = () => ['agent-scheduled-tasks'] as const;
export const pluginsQueryKey = () => ['plugins'] as const;
export const workflowsQueryKey = () => ['workflows'] as const;
export const runsQueryKey = () => ['runs'] as const;

export function useAgentsQuery(workspace?: string) {
  return useQuery({ queryKey: agentsQueryKey(), queryFn: () => api.agents(workspace) });
}

export function useAgentQuery(workspace: string | undefined, agentId: string) {
  return useQuery({ queryKey: ['agent', agentId] as const, queryFn: () => api.agent(workspace, agentId), enabled: Boolean(agentId && agentId !== 'new') });
}

export function useAgentVersionsQuery(workspace: string | undefined, agentId: string) {
  return useQuery({ queryKey: ['agent-versions', agentId] as const, queryFn: () => api.agentVersions(workspace, agentId), enabled: Boolean(agentId), staleTime: 10_000 });
}

export function useAgentSubSessionsQuery(workspace?: string) {
  return useQuery({ queryKey: agentSubSessionsQueryKey(), queryFn: () => api.agentSubSessions(workspace), refetchInterval: 1_500 });
}

export function useAgentScheduledTasksQuery(workspace?: string) {
  return useQuery({ queryKey: agentScheduledTasksQueryKey(), queryFn: () => api.agentScheduledTasks(workspace), refetchInterval: 5_000 });
}

export function usePluginsQuery() {
  return useQuery({ queryKey: pluginsQueryKey(), queryFn: api.plugins, staleTime: 30_000 });
}

export function usePluginQuery(pluginId: string) {
  return useQuery({ queryKey: ['plugin', pluginId] as const, queryFn: () => api.plugin(pluginId), enabled: Boolean(pluginId), refetchInterval: pluginId === 'codex-cli-chat' ? 2_000 : false });
}

export function useWorkflowsQuery(workspace?: string) {
  return useQuery({ queryKey: workflowsQueryKey(), queryFn: () => api.workflows(workspace) });
}

export function useWorkflowQuery(workspace: string | undefined, workflowId: string) {
  return useQuery({ queryKey: ['workflow', workflowId] as const, queryFn: () => api.workflow(workspace, workflowId), enabled: Boolean(workflowId && workflowId !== 'new') });
}

export function useWorkflowVersionsQuery(workspace: string | undefined, workflowId: string) {
  return useQuery({ queryKey: ['workflow-versions', workflowId] as const, queryFn: () => api.workflowVersions(workspace, workflowId), enabled: Boolean(workflowId && workflowId !== 'new') });
}

export function useRunsQuery(workspace?: string) {
  return useQuery({ queryKey: runsQueryKey(), queryFn: () => api.runs(workspace), refetchInterval: 5_000 });
}

export function useRunQuery(workspace: string | undefined, runId: string) {
  return useQuery({ queryKey: ['run', runId] as const, queryFn: () => api.run(workspace, runId), enabled: Boolean(runId), refetchInterval: 3_000 });
}

export function useSkillsQuery(workspace?: string) {
  return useQuery({ queryKey: ['skills'] as const, queryFn: () => api.skills(workspace) });
}

export function useSkillQuery(workspace: string | undefined, skillId: string) {
  return useQuery({ queryKey: ['skill', skillId] as const, queryFn: () => api.skill(workspace, skillId), enabled: Boolean(skillId && skillId !== 'new') });
}

export function useMcpServersQuery(workspace?: string) {
  return useQuery({ queryKey: ['mcp-servers'] as const, queryFn: () => api.mcpServers(workspace) });
}

export function useMcpServerQuery(workspace: string | undefined, serverId: string) {
  return useQuery({ queryKey: ['mcp-server', serverId] as const, queryFn: () => api.mcpServer(workspace, serverId), enabled: Boolean(serverId && serverId !== 'new') });
}

export function useModelProvidersQuery(workspace?: string) {
  return useQuery({ queryKey: ['model-providers'] as const, queryFn: () => api.modelProviders(workspace) });
}

export function useArtifactsQuery(workspace?: string) {
  return useQuery({ queryKey: ['artifacts'] as const, queryFn: () => api.artifacts(workspace) });
}

export function useArtifactQuery(workspace: string | undefined, artifactId: string) {
  return useQuery({ queryKey: ['artifact', artifactId] as const, queryFn: () => api.artifact(workspace, artifactId), enabled: Boolean(artifactId) });
}

export function useUsageQuery(workspace?: string) {
  return useQuery({ queryKey: ['usage'] as const, queryFn: () => api.usage(workspace) });
}

export function useAuditLogsQuery(workspace?: string) {
  return useQuery({ queryKey: ['audit-logs'] as const, queryFn: () => api.auditLogs(workspace) });
}

export function useWorkspaceSettingsQuery() {
  return useQuery({ queryKey: ['settings'] as const, queryFn: api.settings });
}
