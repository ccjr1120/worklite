import { createFileRoute } from '@tanstack/react-router';
import { TeamConfig } from '@/features/executors/team-config';

export const Route = createFileRoute('/coding/$executorId/config')({
  component: AgentTeamConfigRoute,
});

function AgentTeamConfigRoute() {
  const { executorId } = Route.useParams();
  return <TeamConfig executorId={executorId} />;
}
