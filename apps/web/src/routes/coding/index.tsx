import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useCodersQuery } from '@/api/queries';

export const Route = createFileRoute('/coding/')({
  component: CodingIndexRoute,
});

function CodingIndexRoute() {
  const coders = useCodersQuery();
  if (coders.isPending) return null;
  if (coders.isError) return <p>加载 Coder 失败，请重试。</p>;
  const first = coders.data?.[0];
  if (!first) return <p>暂无 Coder。可在 Chat 中创建 Coder。</p>;
  return <Navigate to="/coding/$coderId" params={{ coderId: first.id }} replace />;
}
