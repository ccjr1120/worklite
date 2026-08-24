import { Navigate, useRouterState } from '@tanstack/react-router';
import { useEffect, type ReactNode } from 'react';
import { useSessionStore, type Session } from '@/stores/session-store';

function postAuthRedirect(session: Session) {
  if (session.destination?.startsWith('/') && session.emailVerified && session.onboardingStep === 'complete') {
    return { kind: 'home' as const, teamSlug: session.currentTeamSlug };
  }
  if (!session.emailVerified) {
    return { kind: 'verify' as const };
  }
  if (session.onboardingStep === 'provider') {
    return { kind: 'onboarding-provider' as const };
  }
  if (session.onboardingStep === 'first-agent') {
    return { kind: 'onboarding-agent' as const };
  }
  if (session.onboardingStep !== 'complete') {
    return { kind: 'onboarding-team' as const };
  }
  return { kind: 'home' as const, teamSlug: session.currentTeamSlug };
}

function PostAuthNavigate({ session }: { session: Session }) {
  const target = postAuthRedirect(session);
  if (target.kind === 'verify') return <Navigate to="/verify-email" />;
  if (target.kind === 'onboarding-provider') return <Navigate to="/onboarding/provider" />;
  if (target.kind === 'onboarding-agent') return <Navigate to="/onboarding/first-agent" />;
  if (target.kind === 'onboarding-team') return <Navigate to="/onboarding/team" />;
  return <Navigate to="/$teamSlug/home" params={{ teamSlug: target.teamSlug }} />;
}

function RequireSession({ children }: { children: ReactNode }) {
  const signedIn = useSessionStore((state) => state.signedIn);
  const emailVerified = useSessionStore((state) => state.emailVerified);
  const setDestination = useSessionStore((state) => state.setDestination);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  useEffect(() => {
    if (!signedIn) {
      setDestination(pathname);
    }
  }, [signedIn, pathname, setDestination]);

  if (!signedIn) {
    return <Navigate to="/sign-in" />;
  }

  if (!emailVerified && pathname !== '/verify-email') {
    return <Navigate to="/verify-email" />;
  }

  return children;
}

function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const session = useSessionStore();
  if (session.signedIn) {
    return <PostAuthNavigate session={session} />;
  }
  return children;
}

export { RedirectIfAuthed, RequireSession };
