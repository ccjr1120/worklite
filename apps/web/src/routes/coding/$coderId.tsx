import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/coding/$coderId')({ beforeLoad: () => { throw redirect({ to: '/agents' }); } });
