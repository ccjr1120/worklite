import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/coding/')({ beforeLoad: () => { throw redirect({ to: '/agents' }); } });
