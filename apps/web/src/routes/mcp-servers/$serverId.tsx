import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/mcp-servers/$serverId')({
  beforeLoad: ({ params }) => { throw redirect({ to: '/capabilities/mcp-servers/$serverId', params }); },
});
