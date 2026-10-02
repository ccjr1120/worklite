import { createFileRoute } from '@tanstack/react-router';
import { TeamDetailPage } from '@/features/agent-teams/team-detail';

export const Route = createFileRoute('/agent-teams/$teamId')({
  component: AgentTeamDetailRoute,
});

function AgentTeamDetailRoute() {
  const { teamId } = Route.useParams();
  return <TeamDetailPage teamId={teamId} />;
}
