import { createFileRoute, Navigate } from '@tanstack/react-router';
import { DEFAULT_EXECUTOR_CATEGORY_ID } from '@/features/executor-categories/team-switcher';

export const Route = createFileRoute('/executor-categories/')({
  component: AgentTeamsIndexRoute,
});

function AgentTeamsIndexRoute() {
  return <Navigate to="/executor-categories/$executorCategoryId" params={{ executorCategoryId: DEFAULT_EXECUTOR_CATEGORY_ID }} replace />;
}
