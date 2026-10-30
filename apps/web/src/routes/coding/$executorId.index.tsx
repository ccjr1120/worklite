import { createFileRoute } from '@tanstack/react-router';
import { TeamRecords } from '@/features/executors/team-records';

export const Route = createFileRoute('/coding/$executorId/')({
  component: AgentTeamRecordsRoute,
});

function AgentTeamRecordsRoute() {
  const { executorId } = Route.useParams();
  return <TeamRecords executorId={executorId} />;
}
