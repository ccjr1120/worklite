import { keepPreviousData, useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from './client';
import type { ApiRequestLogQuery, ArtifactListQuery, AssignHomeBoardRequest, CreateHomeBoardCategoryRequest, GatewayRequestLogQuery, PortkeyGatewayStatsQuery, UpdateChatMemoryRequest, UpdateHomeBoardCategoryRequest } from '@worklite/contracts';

export const workflowScheduleQueryKey = (workflowId: string) => ['workflow-schedule', workflowId] as const;
export const pluginsQueryKey = () => ['plugins'] as const;
export const chatConversationsQueryKey = ['chat-conversations'] as const;

export function useChatChannelsQuery() {
  return useQuery({ queryKey: ['chat-channels'], queryFn: api.chatChannels });
}

export const chatMemoriesQueryKey = ['chat-memories'] as const;

export function useChatMemoriesQuery(enabled: boolean) {
  return useQuery({ queryKey: chatMemoriesQueryKey, queryFn: api.chatMemories, enabled });
}

export function useDeleteChatMemoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (memoryId: string) => api.deleteChatMemory(memoryId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatMemoriesQueryKey }),
  });
}

export function useUpdateChatMemoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ memoryId, input }: { memoryId: string; input: UpdateChatMemoryRequest }) => api.updateChatMemory(memoryId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatMemoriesQueryKey }),
  });
}

export function useChatConversationsQuery() {
  return useInfiniteQuery({
    queryKey: chatConversationsQueryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.chatConversations({ cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 5_000,
  });
}

export function useChatConversationRecordsQuery(id: string | null) {
  return useQuery({
    queryKey: ['chat-conversation-records', id],
    queryFn: () => api.chatConversationRecords(id!),
    enabled: Boolean(id),
    // A settled conversation's records no longer change, so only a live one is polled.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 5_000;
      const live = (status: string | undefined) => status === 'running' || status === 'waiting_for_input';
      return live(data.conversation.status) || live(data.execution?.status) ? 5_000 : false;
    },
  });
}

export function useChatProjectOperationQuery(taskId: string, operationKey: string, enabled: boolean) {
  return useQuery({
    queryKey: ['chat-codex-operation', taskId, operationKey],
    queryFn: () => api.chatProjectOperation(taskId, operationKey),
    enabled: Boolean(taskId && operationKey && enabled),
    retry: false,
    staleTime: Infinity,
  });
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
// Nested under ['runs'] so every invalidation of runsQueryKey() also refreshes these.
export const latestSucceededRunsQueryKey = () => ['runs', 'latest-succeeded'] as const;
export const workflowRunsPageQueryKey = (workflowId: string) => ['runs', 'workflow-pages', workflowId] as const;
export const mcpServersQueryKey = () => ['mcp-servers'] as const;
export const artifactsQueryKey = () => ['artifacts'] as const;
export const coderRunStatusCountsQueryKey = () => ['coder-run-status-counts'] as const;
export const agentTeamGroupQueryKey = (groupId: string) => ['agent-team-group', groupId] as const;
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
  return useQuery({ queryKey: ['plugin', pluginId] as const, queryFn: () => api.plugin(pluginId), enabled: Boolean(pluginId), refetchInterval: pluginId === 'feishu-bot' || pluginId === 'wechat-official-account' || pluginId === 'wechat-bot' ? 2_000 : false });
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

/** Per Workflow, the newest succeeded Run on its latest published version: what a Home board renders. */
export function useLatestSucceededRunsQuery(workspace?: string) {
  return useQuery({ queryKey: latestSucceededRunsQueryKey(), queryFn: () => api.latestSucceededRuns(workspace), refetchInterval: 5_000 });
}

/** One Workflow's Runs, newest first, 50 per page. */
export function useWorkflowRunsQuery(workflowId: string) {
  return useInfiniteQuery({
    queryKey: workflowRunsPageQueryKey(workflowId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.workflowRunsPage({ workflowId, cursor: pageParam, limit: 50 }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(workflowId),
    refetchInterval: 5_000,
  });
}

export function useRunQuery(workspace: string | undefined, runId: string, enabled = true) {
  return useQuery({ queryKey: ['run', runId] as const, queryFn: () => api.run(workspace, runId), enabled: Boolean(runId) && enabled, refetchInterval: 3_000 });
}

export const skillsQueryKey = (_workspace?: string) => ['skills'] as const;

export function useSkillsQuery(workspace?: string) {
  return useQuery({ queryKey: skillsQueryKey(workspace), queryFn: () => api.skills(workspace), staleTime: 0 });
}

export function useSkillQuery(workspace: string | undefined, skillId: string) {
  return useQuery({ queryKey: ['skill', skillId] as const, queryFn: () => api.skill(workspace, skillId), enabled: Boolean(skillId) });
}

export function useCodersQuery() {
  return useQuery({ queryKey: ['coders'] as const, queryFn: () => api.executors() });
}

/** Queued and active Run counts for every Coder; one shared request however many cards render. */
export function useCoderRunStatusCountsQuery() {
  return useQuery({ queryKey: coderRunStatusCountsQueryKey(), queryFn: api.coderRunStatusCounts, refetchInterval: 5_000 });
}

export function useAgentTeamQuery(coderId: string) {
  return useQuery({ queryKey: ['coder', coderId] as const, queryFn: () => api.executor(coderId), enabled: Boolean(coderId) });
}

export function useAgentTeamMemoriesQuery(coderId: string) {
  return useQuery({ queryKey: ['coder-memories', coderId] as const, queryFn: () => api.coderMemories(coderId), enabled: Boolean(coderId) });
}

export function useAgentTeamGroupQuery(groupId: string) {
  return useQuery({ queryKey: agentTeamGroupQueryKey(groupId), queryFn: () => api.agentTeamGroup(groupId), enabled: Boolean(groupId), refetchInterval: 5_000 });
}

export function useAgentTeamDocumentQuery(workspace: string | undefined, documentId: string | null) {
  return useQuery({
    queryKey: agentTeamDocumentQueryKey(documentId ?? ''),
    queryFn: () => api.coderDocument(documentId as string),
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

export function agentTeamRunListQueryKey(coderIds?: string[]) {
  const sorted = coderIds ? [...coderIds].sort() : [];
  return ['agent-team-run-list', ...sorted] as const;
}

export function useAgentTeamRunListQuery(coderIds?: string[]) {
  return useInfiniteQuery({
    queryKey: agentTeamRunListQueryKey(coderIds),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.agentTeamRunList({ coderIds, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: (query) => query.state.data?.pages.some((page) =>
      page.items.some((run) => !['succeeded', 'failed', 'cancelled'].includes(run.status)),
    ) ? 5_000 : 30_000,
  });
}

const RUN_NODES_BATCH_SIZE = 50;

// Batch reads of the node trees for the expanded Runs: one request per 50 Runs (the server
// limit), so a page of Runs is one request. The ids are sorted so expanding in a different
// order reuses the cache; trees refresh while any expanded Run is in progress.
export function useAgentTeamRunNodesQuery(runIds: string[], refresh: boolean) {
  const sorted = [...new Set(runIds)].sort();
  const batches: string[][] = [];
  for (let index = 0; index < sorted.length; index += RUN_NODES_BATCH_SIZE) batches.push(sorted.slice(index, index + RUN_NODES_BATCH_SIZE));
  return useQueries({
    queries: batches.map((batch) => ({
      queryKey: ['agent-team-run-nodes', ...batch] as const,
      queryFn: () => api.agentTeamRunNodes(batch),
      placeholderData: keepPreviousData,
      refetchInterval: refresh ? 5_000 : false as const,
    })),
    combine: (results) => ({
      nodesByRun: new Map(results.flatMap((result) => result.data?.runs.map((run) => [run.runId, run.nodes] as const) ?? [])),
      // Older servers omit the Run total; callers treat a missing entry as not reported.
      totalTokensByRun: new Map(results.flatMap((result) => result.data?.runs.flatMap((run) => run.totalTokens ? [[run.runId, run.totalTokens] as const] : []) ?? [])),
      retentionHours: results.find((result) => result.data)?.data?.requestLogRetentionHours ?? 12,
      // Placeholder data is the previous batch, which lacks a newly expanded Run.
      loading: results.some((result) => result.isPending || result.isPlaceholderData),
      isError: results.some((result) => result.isError && !result.data),
    }),
  });
}

// One Run's node tree for its Chat card. It shares the node-tree cache key of a one-Run batch,
// refreshes every 5 seconds while the Run is live, and is read once more when the Run settles,
// after which it is not refetched.
export function useAgentTeamRunUsageQuery(runId: string, live: boolean) {
  const client = useQueryClient();
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) void client.invalidateQueries({ queryKey: ['agent-team-run-nodes', runId], exact: true });
    wasLive.current = live;
  }, [client, live, runId]);
  return useQuery({
    queryKey: ['agent-team-run-nodes', runId] as const,
    queryFn: () => api.agentTeamRunNodes([runId]),
    enabled: Boolean(runId),
    refetchInterval: live ? 5_000 : false,
    staleTime: live ? 0 : Number.POSITIVE_INFINITY,
    select: (tree) => {
      const run = tree.runs.find((item) => item.runId === runId);
      return { nodes: run?.nodes ?? [], totalTokens: run?.totalTokens ?? null, retentionHours: tree.requestLogRetentionHours };
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

// Attribution filters are part of the question, so they are part of the cache key;
// leaving them out would serve a Chat-only answer for a Coder-only request.
function attributionKey(query: { surface?: string; conversationId?: string; projectTaskId?: string; executor?: string; coderId?: string; teamRunId?: string; workflowId?: string; workflowRunId?: string; nodeRunId?: string }) {
  return [query.surface ?? '', query.conversationId ?? '', query.projectTaskId ?? '', query.executor ?? '', query.coderId ?? '', query.teamRunId ?? '', query.workflowId ?? '', query.workflowRunId ?? '', query.nodeRunId ?? ''] as const;
}

export function usePortkeyGatewayStatsQuery(query: PortkeyGatewayStatsQuery) {
  return useQuery({
    queryKey: ['portkey-gateway-stats', query.from ?? '', query.to ?? '', query.groupBy ?? '', ...attributionKey(query)] as const,
    queryFn: () => api.portkeyGatewayStats(query),
    refetchInterval: 30_000,
  });
}

export function useGatewayRequestLogsQuery(query: GatewayRequestLogQuery) {
  return useQuery({
    queryKey: ['gateway-request-logs', query.from ?? '', query.to ?? '', query.provider ?? '', query.model ?? '', query.statusClass ?? '', ...attributionKey(query)] as const,
    queryFn: () => api.gatewayRequestLogs(query),
    refetchInterval: 30_000,
  });
}

export function useApiRequestLogStatsQuery(query: ApiRequestLogQuery) {
  return useQuery({
    queryKey: ['api-request-log-stats', query.from ?? '', query.to ?? '', query.method ?? ''] as const,
    queryFn: () => api.apiRequestLogStats(query),
    refetchInterval: 30_000,
  });
}

export function useApiRequestLogsQuery(query: ApiRequestLogQuery) {
  return useQuery({
    queryKey: ['api-request-logs', query.from ?? '', query.to ?? '', query.method ?? '', query.route ?? '', query.minDurationMs ?? '', query.statusClass ?? ''] as const,
    queryFn: () => api.apiRequestLogs(query),
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

export function useArtifactListQuery(workspace: string | undefined, query: ArtifactListQuery) {
  return useQuery({
    queryKey: ['artifacts', query] as const,
    queryFn: () => api.artifacts(workspace, query),
    placeholderData: keepPreviousData,
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
