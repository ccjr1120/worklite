import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/coding/$coderId')({
  component: CoderLayout,
});

function CoderLayout() {
  return <Outlet />;
}
