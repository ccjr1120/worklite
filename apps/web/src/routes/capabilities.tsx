import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/capabilities')({
  component: CapabilitiesLayout,
});

function CapabilitiesLayout() {
  return <Outlet />;
}
