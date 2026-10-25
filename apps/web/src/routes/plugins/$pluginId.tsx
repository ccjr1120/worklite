import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/plugins/$pluginId')({
  beforeLoad: ({ params }) => { throw redirect({ to: '/capabilities/plugins/$pluginId', params }); },
});
