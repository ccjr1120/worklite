import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/coding/runs/$runId')({ beforeLoad: () => { throw redirect({ to: '/agents' }); } });
