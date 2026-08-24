import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/$teamSlug/')({
  component: function TeamIndex() {
    const { teamSlug } = Route.useParams();
    return <Navigate to="/$teamSlug/home" params={{ teamSlug }} />;
  },
});
