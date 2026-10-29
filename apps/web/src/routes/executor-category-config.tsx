import { createFileRoute, Navigate } from '@tanstack/react-router';
import { DEFAULT_EXECUTOR_CATEGORY_ID } from '@/features/executor-categories/team-switcher';

// Compatibility entry for the former fixed configuration page.
export const Route = createFileRoute('/executor-category-config')({
  component: LegacyAgentTeamConfigRoute,
});

function LegacyAgentTeamConfigRoute() {
  return <Navigate to="/executor-categories/$executorCategoryId/config" params={{ executorCategoryId: DEFAULT_EXECUTOR_CATEGORY_ID }} replace />;
}
