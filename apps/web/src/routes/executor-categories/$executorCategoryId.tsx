import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/executor-categories/$executorCategoryId')({
  component: AgentTeamLayout,
});

function AgentTeamLayout() {
  return <Outlet />;
}
