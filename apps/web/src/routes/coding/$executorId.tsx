import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/coding/$executorId')({
  component: AgentTeamLayout,
});

function AgentTeamLayout() {
  return <Outlet />;
}
