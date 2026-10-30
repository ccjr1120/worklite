import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useAgentTeamsQuery } from '@/api/queries';

export const Route = createFileRoute('/coding/')({
  component: AgentTeamsIndexRoute,
});

function AgentTeamsIndexRoute() {
  const teams = useAgentTeamsQuery();
  if (teams.isPending) return null;
  if (teams.isError) return <p>加载执行器失败，请重试。</p>;
  const first = teams.data?.[0];
  if (!first) return <p>暂无执行器。可在 Chat 中创建执行器。</p>;
  return <Navigate to="/coding/$executorId" params={{ executorId: first.id }} replace />;
}
