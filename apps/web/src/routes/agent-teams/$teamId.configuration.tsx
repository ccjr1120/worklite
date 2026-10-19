import { createFileRoute } from '@tanstack/react-router';
import { TeamDetailPage } from '@/features/agent-teams/team-detail';

export const Route = createFileRoute('/agent-teams/$teamId/configuration')({
  component: AgentTeamConfigurationRoute,
});

function AgentTeamConfigurationRoute() {
  const { teamId } = Route.useParams();
  return <TeamDetailPage teamId={teamId} view="configuration" />;
}
