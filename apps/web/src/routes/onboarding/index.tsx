import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useSessionStore } from '@/stores/session-store';

export const Route = createFileRoute('/onboarding/')({
  component: OnboardingIndex,
});

function OnboardingIndex() {
  const step = useSessionStore((state) => state.onboardingStep);
  if (step === 'provider') return <Navigate to="/onboarding/provider" />;
  if (step === 'first-agent') return <Navigate to="/onboarding/first-agent" />;
  return <Navigate to="/onboarding/provider" />;
}
