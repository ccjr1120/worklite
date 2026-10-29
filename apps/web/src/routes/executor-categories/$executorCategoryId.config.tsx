import { createFileRoute } from '@tanstack/react-router';
import { TeamConfig } from '@/features/executor-categories/team-config';

export const Route = createFileRoute('/executor-categories/$executorCategoryId/config')({
  component: AgentTeamConfigRoute,
});

function AgentTeamConfigRoute() {
  const { executorCategoryId } = Route.useParams();
  return <TeamConfig executorCategoryId={executorCategoryId} />;
}
