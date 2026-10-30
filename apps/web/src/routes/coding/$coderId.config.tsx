import { createFileRoute } from '@tanstack/react-router';
import { CoderConfig } from '@/features/coders/coder-config';

export const Route = createFileRoute('/coding/$coderId/config')({
  component: CoderConfigRoute,
});

function CoderConfigRoute() {
  const { coderId } = Route.useParams();
  return <CoderConfig coderId={coderId} />;
}
