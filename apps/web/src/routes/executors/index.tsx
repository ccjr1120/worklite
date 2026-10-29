import { createFileRoute, Navigate } from '@tanstack/react-router';
import { DEFAULT_EXECUTOR_CATEGORY_ID } from '@/features/executor-categories/team-switcher';

export const Route = createFileRoute('/executors/')({
  component: AgentTeamsIndexRoute,
});

function AgentTeamsIndexRoute() {
  return <Navigate to="/executors/$executorId" params={{ executorId: DEFAULT_EXECUTOR_CATEGORY_ID }} replace />;
}
