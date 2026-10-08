import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { AssignHomeBoardRequest, CreateHomeBoardCategoryRequest, GatewayRequestLogQuery, GatewayTimeRange, UpdateHomeBoardCategoryRequest } from '@worklite/contracts';

export const workflowScheduleQueryKey = (workflowId: string) => ['workflow-schedule', workflowId] as const;
export const pluginsQueryKey = () => ['plugins'] as const;
export const chatConversationsQueryKey = ['chat-conversations'] as const;

export function useChatChannelsQuery() {
  return useQuery({ queryKey: ['chat-channels'], queryFn: api.chatChannels });
}

export function useChatConversationsQuery(search = '', channel = '') {
  return useInfiniteQuery({
    queryKey: [...chatConversationsQueryKey, search, channel],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.chatConversations({ cursor: pageParam, search, channel }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 5_000,
  });
}

export function useChatConversationQuery(id: string | null) {
  return useQuery({ queryKey: ['chat-conversation', id], queryFn: () => api.chatConversation(id!), enabled: Boolean(id), refetchInterval: 5_000 });
}

export function useChatConversationRecordsQuery(id: string | null) {
  return useQuery({ queryKey: ['chat-conversation-records', id], queryFn: () => api.chatConversationRecords(id!), enabled: Boolean(id), refetchInterval: 5_000 });
}

export function useWorkliteUpgradeQuery(id: string) {
  return useQuery({
    queryKey: ['worklite-upgrade', id],
    queryFn: () => api.workliteUpgrade(id),
    enabled: Boolean(id),
    refetchInterval: (query) => ['proposed', 'succeeded', 'rolled_back', 'failed'].includes(query.state.data?.phase ?? '') ? false : 5_000,
  });
}
export const workflowsQueryKey = () => ['workflows'] as const;
export const runsQueryKey = () => ['runs'] as const;
export const mcpServersQueryKey = () => ['mcp-servers'] as const;
export const artifactsQueryKey = () => ['artifacts'] as const;
export const agentTeamQueryKey = (teamId: string) => ['agent-team', teamId] as const;
export const agentTeamConversationQueryKey = (teamId: string) => ['agent-team-conversation', teamId] as const;
export const agentTeamRunQueryKey = (runId: string) => ['agent-team-run', runId] as const;
const agentTeamDocumentQueryKey = (documentId: string) => ['agent-team-document', documentId] as const;

export function useWorkflowsQuery(workspace?: string, options?: { refetchInterval?: number | false }) {
  return useQuery({ queryKey: workflowsQueryKey(), queryFn: () => api.workflows(workspace), refetchInterval: options?.refetchInterval });
}

export function useAgentQuery(workspace: string | undefined, agentId: string) {
  return useQuery({ queryKey: ['agent', agentId] as const, queryFn: () => api.agent(workspace, agentId), enabled: Boolean(agentId && agentId !== 'new') });
}

export function useWorkflowScheduleQuery(workspace: string | undefined, workflowId: string) {
  return useQuery({
    queryKey: workflowScheduleQueryKey(workflowId),
    queryFn: () => api.workflowSchedule(workspace, workflowId),
    enabled: Boolean(workflowId && workflowId !== 'new'),
    refetchInterval: 5_000,
  });
}

export function usePluginsQuery() {
  return useQuery({ queryKey: pluginsQueryKey(), queryFn: api.plugins, staleTime: 30_000 });
}

export function usePluginQuery(pluginId: string) {
  return useQuery({ queryKey: ['plugin', pluginId] as const, queryFn: () => api.plugin(pluginId), enabled: Boolean(pluginId), refetchInterval: pluginId === 'feishu-bot' || pluginId === 'wechat-official-account' ? 2_000 : false });
}

const homeBoardPreferencesQueryKey = ['home-board-preferences'] as const;

export function useHomeBoardPreferencesQuery(workspace?: string) {
  return useQuery({ queryKey: homeBoardPreferencesQueryKey, queryFn: () => api.homeBoardPreferences(workspace) });
}

export function useCreateHomeBoardCategoryMutation(workspace?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateHomeBoardCategoryRequest) => api.createHomeBoardCategory(workspace, input),
    onSuccess: (data) => queryClient.setQueryData(homeBoardPreferencesQueryKey, data),
  });
}

export function useRenameHomeBoardCategoryMutation(workspace?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ categoryId, name }: UpdateHomeBoardCategoryRequest & { categoryId: string }) => api.renameHomeBoardCategory(workspace, categoryId, { name }),
    onSuccess: (data) => queryClient.setQueryData(homeBoardPreferencesQueryKey, data),
  });
}

export function useDeleteHomeBoardCategoryMutation(workspace?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (categoryId: string) => api.deleteHomeBoardCategory(workspace, categoryId),
    onSuccess: (data) => queryClient.setQueryData(homeBoardPreferencesQueryKey, data),
  });
}

export function useAssignHomeBoardMutation(workspace?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AssignHomeBoardRequest) => api.assignHomeBoard(workspace, input),
    onSuccess: (data) => queryClient.setQueryData(homeBoardPreferencesQueryKey, data),
  });
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

export function useRunQuery(workspace: string | undefined, runId: string, enabled = true) {
  return useQuery({ queryKey: ['run', runId] as const, queryFn: () => api.run(workspace, runId), enabled: Boolean(runId) && enabled, refetchInterval: 3_000 });
}

export const skillsQueryKey = (_workspace?: string) => ['skills'] as const;

export function useSkillsQuery(workspace?: string) {
  return useQuery({ queryKey: skillsQueryKey(workspace), queryFn: () => api.skills(workspace) });
}

export function useSkillQuery(workspace: string | undefined, skillId: string) {
  return useQuery({ queryKey: ['skill', skillId] as const, queryFn: () => api.skill(workspace, skillId), enabled: Boolean(skillId && skillId !== 'new') });
}

export function useAgentTeamQuery(workspace: string | undefined, teamId: string) {
  return useQuery({ queryKey: agentTeamQueryKey(teamId), queryFn: () => api.agentTeam(teamId), enabled: Boolean(workspace && teamId) });
}

export function useAgentTeamConversationQuery(workspace: string | undefined, teamId: string) {
  return useQuery({
    queryKey: agentTeamConversationQueryKey(teamId),
    queryFn: () => api.agentTeamConversation(teamId),
    enabled: Boolean(workspace && teamId),
  });
}

export function useAgentTeamDocumentQuery(workspace: string | undefined, documentId: string | null) {
  return useQuery({
    queryKey: agentTeamDocumentQueryKey(documentId ?? ''),
    queryFn: () => api.agentTeamDocument(documentId as string),
    enabled: Boolean(workspace && documentId),
  });
}

export function useAgentTeamRunQuery(workspace: string | undefined, runId: string) {
  return useQuery({
    queryKey: agentTeamRunQueryKey(runId),
    queryFn: () => api.agentTeamRun(runId),
    enabled: Boolean(workspace && runId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'succeeded' || status === 'failed' || status === 'cancelled' ? false : 3_000;
    },
  });
}

export function useMcpServersQuery(workspace?: string) {
  return useQuery({ queryKey: mcpServersQueryKey(), queryFn: () => api.mcpServers(workspace) });
}

export function useMcpServerQuery(workspace: string | undefined, serverId: string) {
  return useQuery({ queryKey: ['mcp-server', serverId] as const, queryFn: () => api.mcpServer(workspace, serverId), enabled: Boolean(serverId && serverId !== 'new') });
}

export function useModelProvidersQuery(workspace?: string) {
  return useQuery({ queryKey: ['model-providers'] as const, queryFn: () => api.modelProviders(workspace) });
}

export function usePortkeyGatewayQuery() {
  return useQuery({ queryKey: ['portkey-gateway'] as const, queryFn: api.portkeyGateway });
}

export function useCodexAuthQuery() {
  return useQuery({ queryKey: ['codex-auth'] as const, queryFn: api.codexAuthStatus, refetchInterval: 2_000 });
}

export function useCodexAccountUsagesQuery(enabled: boolean) {
  return useQuery({ queryKey: ['codex-account-usages'] as const, queryFn: api.codexAccountUsages, enabled, refetchInterval: 60_000 });
}

export function usePortkeyGatewayStatsQuery(range: GatewayTimeRange) {
  return useQuery({
    queryKey: ['portkey-gateway-stats', range.from ?? '', range.to ?? ''] as const,
    queryFn: () => api.portkeyGatewayStats(range),
    refetchInterval: 30_000,
  });
}

export function useGatewayRequestLogsQuery(query: GatewayRequestLogQuery) {
  return useQuery({
    queryKey: ['gateway-request-logs', query.from ?? '', query.to ?? '', query.provider ?? '', query.model ?? '', query.statusClass ?? '', query.workflowRunId ?? '', query.teamRunId ?? ''] as const,
    queryFn: () => api.gatewayRequestLogs(query),
    refetchInterval: 30_000,
  });
}

export function useGatewayRequestLogQuery(requestLogId?: string) {
  return useQuery({
    queryKey: ['gateway-request-log', requestLogId ?? ''] as const,
    queryFn: () => api.gatewayRequestLog(requestLogId as string),
    enabled: Boolean(requestLogId),
  });
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
