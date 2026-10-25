import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/mcp-servers/')({
  beforeLoad: () => { throw redirect({ to: '/capabilities' }); },
});
