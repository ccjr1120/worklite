import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/$teamSlug/settings/')({
  component: function SettingsIndex() {
    const { teamSlug } = Route.useParams();
    return <Navigate to="/$teamSlug/settings/general" params={{ teamSlug }} />;
  },
});
