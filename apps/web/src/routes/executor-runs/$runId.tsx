import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { LegacyTeamRunDialog } from '@/features/executors/team-run-detail';

export const Route = createFileRoute('/executor-runs/$runId')({
  component: AgentTeamRunDetailRoute,
});

function AgentTeamRunDetailRoute() {
  const { runId } = Route.useParams();
  const navigate = useNavigate();
  return <LegacyTeamRunDialog runId={runId} onClose={() => void navigate({ to: '/coding' })} />;
}
