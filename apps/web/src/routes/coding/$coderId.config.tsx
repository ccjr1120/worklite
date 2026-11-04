import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/coding/$coderId/config')({ beforeLoad: () => { throw redirect({ to: '/agents' }); } });
