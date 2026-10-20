import { createFileRoute } from '@tanstack/react-router';
import { TeamConfig } from '@/features/agent-teams/team-config';

export const Route = createFileRoute('/agent-team-config')({
  component: TeamConfig,
});
