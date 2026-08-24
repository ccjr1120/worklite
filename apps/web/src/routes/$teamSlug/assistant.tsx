import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/$teamSlug/assistant')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/$teamSlug/home',
      params: { teamSlug: params.teamSlug },
      search: { assistant: 'open' },
      replace: true,
    });
  },
});
