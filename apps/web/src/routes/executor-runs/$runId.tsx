import { createFileRoute } from '@tanstack/react-router';
import { TeamRunDetailPage } from '@/features/executors/team-run-detail';

export const Route = createFileRoute('/executor-runs/$runId')({
  component: AgentTeamRunDetailRoute,
});

function AgentTeamRunDetailRoute() {
  const { runId } = Route.useParams();
  return <TeamRunDetailPage runId={runId} />;
}
