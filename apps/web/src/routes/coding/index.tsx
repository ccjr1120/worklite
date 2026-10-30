import { createFileRoute, Navigate } from '@tanstack/react-router';
import { DEFAULT_EXECUTOR_CATEGORY_ID } from '@/features/executors/team-switcher';

export const Route = createFileRoute('/coding/')({
  component: AgentTeamsIndexRoute,
});

function AgentTeamsIndexRoute() {
  return <Navigate to="/coding/$executorId" params={{ executorId: DEFAULT_EXECUTOR_CATEGORY_ID }} replace />;
}
