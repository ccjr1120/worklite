import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/workflows/$workflowId/versions')({ beforeLoad: () => { throw redirect({ to: '/agents' }); } });
