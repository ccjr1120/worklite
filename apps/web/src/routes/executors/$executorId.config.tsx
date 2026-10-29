import { createFileRoute } from '@tanstack/react-router';
import { TeamConfig } from '@/features/executor-categories/team-config';

export const Route = createFileRoute('/executors/$executorId/config')({
  component: AgentTeamConfigRoute,
});

function AgentTeamConfigRoute() {
  const { executorId } = Route.useParams();
  return <TeamConfig executorId={executorId} />;
}
