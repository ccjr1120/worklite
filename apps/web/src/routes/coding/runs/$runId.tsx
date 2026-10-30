import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { LegacyCoderRunDialog } from '@/features/coders/coder-run-detail';

export const Route = createFileRoute('/coding/runs/$runId')({
  component: CoderRunDetailRoute,
});

function CoderRunDetailRoute() {
  const { runId } = Route.useParams();
  const navigate = useNavigate();
  return <LegacyCoderRunDialog runId={runId} onClose={() => void navigate({ to: '/coding' })} />;
}
