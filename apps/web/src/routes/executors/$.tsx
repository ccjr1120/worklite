import { createFileRoute, redirect } from '@tanstack/react-router';

// Legacy link compatibility: `/executors/*` moved to `/coding/*`, keeping the search string.
export const Route = createFileRoute('/executors/$')({
  beforeLoad: ({ params, location }) => {
    throw redirect({ href: `/coding/${params._splat ?? ''}${location.searchStr}`, replace: true });
  },
});
