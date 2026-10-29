import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/executors/$executorId')({
  component: AgentTeamLayout,
});

function AgentTeamLayout() {
  return <Outlet />;
}
