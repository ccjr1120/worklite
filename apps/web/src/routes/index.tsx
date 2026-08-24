import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useSessionStore } from '@/stores/session-store';

export const Route = createFileRoute('/')({
  component: IndexPage,
});

function IndexPage() {
  const session = useSessionStore();
  if (!session.signedIn) {
    return <Navigate to="/sign-in" />;
  }
  if (!session.emailVerified) {
    return <Navigate to="/verify-email" />;
  }
  if (session.onboardingStep === 'provider') {
    return <Navigate to="/onboarding/provider" />;
  }
  if (session.onboardingStep === 'first-agent') {
    return <Navigate to="/onboarding/first-agent" />;
  }
  if (session.onboardingStep !== 'complete') {
    return <Navigate to="/onboarding/team" />;
  }
  return <Navigate to="/$teamSlug/home" params={{ teamSlug: session.currentTeamSlug }} />;
}
