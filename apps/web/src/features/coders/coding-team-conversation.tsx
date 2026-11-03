import { useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { agentTeamGroupQueryKey, agentTeamRunQueryKey, useAgentTeamGroupQuery, useAgentTeamRunQuery } from '@/api/queries';
import { StreamingMarkdown } from '@/components/ai/streaming-markdown';
import { ErrorState } from '@/components/error-state';
import { Skeleton } from '@/components/ui/skeleton';

function Conversation({ groupId, runId }: { groupId: string; runId: string }) {
  const queryClient = useQueryClient();
  const query = useAgentTeamGroupQuery(groupId);
  useEffect(() => {
    const events = new EventSource(api.coderGroupEventsUrl(groupId), { withCredentials: true });
    // Refetch on every connection, including reconnects, to recover missed events.
    events.onopen = () => void queryClient.invalidateQueries({ queryKey: agentTeamGroupQueryKey(groupId) });
    events.onmessage = () => void queryClient.invalidateQueries({ queryKey: agentTeamGroupQueryKey(groupId) });
    return () => events.close();
  }, [groupId, queryClient]);
  if (query.isPending) return <Skeleton className="h-28 w-full" role="status" />;
  if (query.isError || !query.data) return <ErrorState title="无法加载团队对话" description="请重试。" onAction={() => void query.refetch()} />;
  const messages = query.data.messages.filter((message) => message.runId === runId);
  const tasks = query.data.runs?.find((run) => run.id === runId)?.tasks ?? [];
  return <div className="space-y-5" aria-label="团队对话">
    {tasks.length ? <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="角色任务状态">
      {tasks.map((task) => <span key={task.taskAttemptId}>{task.role} · {taskStatusLabel(task.status)}</span>)}
    </div> : null}
    {messages.map((message) => <article key={message.id} className="space-y-2">
      <div className="text-sm font-semibold">{message.sender === 'user' ? '用户' : message.sender === 'system' ? '系统' : message.senderRole}</div>
      <div className="rounded-xl border border-border bg-surface p-4 text-sm">
        {message.recipientRole && message.recipientRole !== message.senderRole ? <span className="mr-2 font-medium text-primary">@{message.recipientRole}</span> : null}
        <StreamingMarkdown content={message.body} />
      </div>
    </article>)}
  </div>;
}

function taskStatusLabel(status: string): string {
  return ({
    running: '运行中',
    stop_requested: '停止中',
    waiting_for_input: '等待输入',
    waiting_for_recovery: '等待恢复',
    completed: '已完成',
    failed: '失败',
    stopped: '已停止',
    cancelled: '已取消',
  } satisfies Record<string, string>)[status] ?? status;
}

export function CodingTeamConversation({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const query = useAgentTeamRunQuery('personal', runId);
  useEffect(() => {
    const events = new EventSource(api.coderRunEventsUrl(runId), { withCredentials: true });
    events.onopen = () => void queryClient.invalidateQueries({ queryKey: agentTeamRunQueryKey(runId) });
    events.onmessage = () => void queryClient.invalidateQueries({ queryKey: agentTeamRunQueryKey(runId) });
    return () => events.close();
  }, [runId, queryClient]);
  if (query.isPending) return <Skeleton className="h-28 w-full" role="status" />;
  if (query.isError || !query.data) return <ErrorState title="无法加载团队对话" description="请重试。" onAction={() => void query.refetch()} />;
  return <div className="space-y-6">
    {query.data.groupId ? <Conversation groupId={query.data.groupId} runId={runId} /> : <div aria-label="团队对话" />}
    <Link to="/chat" className="inline-block text-sm underline">在 Chat 中处理任务</Link>
  </div>;
}
