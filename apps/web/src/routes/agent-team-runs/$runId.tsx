import { createFileRoute } from '@tanstack/react-router';
import { TeamRunDetailPage } from '@/features/agent-teams/team-run-detail';

export const Route = createFileRoute('/agent-team-runs/$runId')({
  component: AgentTeamRunDetailRoute,
});

function AgentTeamRunDetailRoute() {
  const { runId } = Route.useParams();
  return <TeamRunDetailPage runId={runId} />;
}
