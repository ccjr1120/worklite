import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/agent-teams/$teamId')({
  component: AgentTeamLayout,
});

function AgentTeamLayout() {
  return <Outlet />;
}
