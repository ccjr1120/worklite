import { createFileRoute } from '@tanstack/react-router';
import { TeamRecords } from '@/features/executor-categories/team-records';

export const Route = createFileRoute('/executor-categories/$executorCategoryId/')({
  component: AgentTeamRecordsRoute,
});

function AgentTeamRecordsRoute() {
  const { executorCategoryId } = Route.useParams();
  return <TeamRecords executorCategoryId={executorCategoryId} />;
}
