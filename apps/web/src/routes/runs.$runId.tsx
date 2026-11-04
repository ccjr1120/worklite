import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/runs/$runId')({ beforeLoad: () => { throw redirect({ to: '/agents' }); } });
