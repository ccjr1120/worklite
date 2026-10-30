import { createFileRoute } from '@tanstack/react-router';
import { CoderRecords } from '@/features/coders/coder-records';

export const Route = createFileRoute('/coding/$coderId/')({
  component: CoderRecordsRoute,
});

function CoderRecordsRoute() {
  const { coderId } = Route.useParams();
  return <CoderRecords coderId={coderId} />;
}
