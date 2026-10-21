import { createFileRoute } from '@tanstack/react-router';
import { TeamConfig } from '@/features/agent-teams/team-config';

export const Route = createFileRoute('/agent-teams/$teamId/config')({
  component: AgentTeamConfigRoute,
});

function AgentTeamConfigRoute() {
  const { teamId } = Route.useParams();
  return <TeamConfig teamId={teamId} />;
}
