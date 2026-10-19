import { createFileRoute } from '@tanstack/react-router';
import { AgentTeamGroupChatPage } from '@/features/agent-teams/group-chat';

export const Route = createFileRoute('/agent-team-groups/$groupId')({
  component: AgentTeamGroupRoute,
});

function AgentTeamGroupRoute() {
  const { groupId } = Route.useParams();
  return <AgentTeamGroupChatPage groupId={groupId} />;
}
