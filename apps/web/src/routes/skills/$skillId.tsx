import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/skills/$skillId')({
  beforeLoad: ({ params }) => { throw redirect({ to: '/capabilities/skills/$skillId', params }); },
});
