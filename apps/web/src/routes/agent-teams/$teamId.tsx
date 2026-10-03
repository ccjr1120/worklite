import { createFileRoute } from '@tanstack/react-router';
import { TeamDetailPage } from '@/features/agent-teams/team-detail';

const AGENT_TEAM_TABS = ['conversation', 'configuration'] as const;
type AgentTeamTab = (typeof AGENT_TEAM_TABS)[number];
type AgentTeamDetailSearch = {
  tab: AgentTeamTab;
};

function isAgentTeamTab(value: unknown): value is AgentTeamTab {
  return typeof value === 'string' && AGENT_TEAM_TABS.includes(value as AgentTeamTab);
}

export const Route = createFileRoute('/agent-teams/$teamId')({
  validateSearch: (search: Record<string, unknown>): AgentTeamDetailSearch => ({
    tab: isAgentTeamTab(search.tab) ? search.tab : 'conversation',
  }),
  component: AgentTeamDetailRoute,
});

function AgentTeamDetailRoute() {
  const { teamId } = Route.useParams();
  const { tab } = Route.useSearch();
  return <TeamDetailPage teamId={teamId} tab={tab} />;
}
