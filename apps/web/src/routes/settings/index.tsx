import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/')({
  component: function SettingsIndex() {
    return <Navigate to="/settings/appearance" params={{}} />;
  },
});
