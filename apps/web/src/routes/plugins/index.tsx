import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/plugins/')({
  beforeLoad: () => { throw redirect({ to: '/capabilities' }); },
});
