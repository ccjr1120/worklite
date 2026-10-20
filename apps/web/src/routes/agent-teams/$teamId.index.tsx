import { createFileRoute } from '@tanstack/react-router';
import { TeamRecords } from '@/features/agent-teams/team-records';

export const Route = createFileRoute('/agent-teams/$teamId/')({
  component: AgentTeamRecordsRoute,
});

function AgentTeamRecordsRoute() {
  const { teamId } = Route.useParams();
  return <TeamRecords teamId={teamId} />;
}
