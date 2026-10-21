import { createFileRoute, Navigate } from '@tanstack/react-router';
import { DEFAULT_AGENT_TEAM_ID } from '@/features/agent-teams/team-switcher';

// Compatibility entry for the former fixed configuration page.
export const Route = createFileRoute('/agent-team-config')({
  component: LegacyAgentTeamConfigRoute,
});

function LegacyAgentTeamConfigRoute() {
  return <Navigate to="/agent-teams/$teamId/config" params={{ teamId: DEFAULT_AGENT_TEAM_ID }} replace />;
}
