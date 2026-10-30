import { createFileRoute, redirect } from '@tanstack/react-router';

// Legacy link compatibility: `/executors` moved to `/coding`.
export const Route = createFileRoute('/executors/')({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/coding${location.searchStr}`, replace: true });
  },
});
