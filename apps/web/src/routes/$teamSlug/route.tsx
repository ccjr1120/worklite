import { createFileRoute } from '@tanstack/react-router';
import { RequireSession } from '@/components/require-session';
import { WorkspaceShell } from '@/components/workspace/workspace-shell';

export const Route = createFileRoute('/$teamSlug')({
  component: TeamLayout,
});

function TeamLayout() {
  return (
    <RequireSession>
      <WorkspaceShell />
    </RequireSession>
  );
}
