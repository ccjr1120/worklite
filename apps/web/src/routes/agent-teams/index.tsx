import { createFileRoute, Navigate } from '@tanstack/react-router';
import { DEFAULT_AGENT_TEAM_ID } from '@/features/agent-teams/team-switcher';

export const Route = createFileRoute('/agent-teams/')({
  component: AgentTeamsIndexRoute,
});

function AgentTeamsIndexRoute() {
  return <Navigate to="/agent-teams/$teamId" params={{ teamId: DEFAULT_AGENT_TEAM_ID }} replace />;
}
