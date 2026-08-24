import { create } from 'zustand';
import { currentUser, teams } from '@/mock/data';

const SESSION_KEY = 'worklite.session';

export type OnboardingStep = 'team' | 'provider' | 'first-agent' | 'complete';

export type Session = {
  signedIn: boolean;
  emailVerified: boolean;
  email: string;
  name: string;
  onboardingStep: OnboardingStep;
  currentTeamSlug: string;
  destination: string | null;
  sessionExpired: boolean;
};

const defaultSession: Session = {
  signedIn: false,
  emailVerified: false,
  email: '',
  name: '',
  onboardingStep: 'team',
  currentTeamSlug: teams[0]?.slug ?? 'acme',
  destination: null,
  sessionExpired: false,
};

function readSession(): Session {
  if (typeof window === 'undefined') {
    return defaultSession;
  }

  const raw = window.localStorage.getItem(SESSION_KEY);
  if (!raw) {
    return defaultSession;
  }

  try {
    return { ...defaultSession, ...(JSON.parse(raw) as Partial<Session>) };
  } catch {
    return defaultSession;
  }
}

function persist(session: Session) {
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

type SessionStore = Session & {
  setDestination: (destination: string | null) => void;
  signIn: (email: string) => void;
  signUp: (name: string, email: string) => void;
  verifyEmail: () => void;
  completeOnboardingStep: (step: OnboardingStep) => void;
  setTeam: (slug: string) => void;
  expireSession: () => void;
  signOut: () => void;
};

export const useSessionStore = create<SessionStore>((set, get) => ({
  ...readSession(),
  setDestination: (destination) => {
    const next = { ...get(), destination };
    persist(next);
    set(next);
  },
  signIn: (email) => {
    const destination = get().destination;
    const next: Session = {
      signedIn: true,
      emailVerified: true,
      email,
      name: currentUser.name,
      onboardingStep: 'complete',
      currentTeamSlug: teams[0]?.slug ?? 'acme',
      destination,
      sessionExpired: false,
    };
    persist(next);
    set(next);
  },
  signUp: (name, email) => {
    const next: Session = {
      ...get(),
      signedIn: true,
      emailVerified: false,
      email,
      name,
      onboardingStep: 'team',
      sessionExpired: false,
    };
    persist(next);
    set(next);
  },
  verifyEmail: () => {
    const next = { ...get(), emailVerified: true };
    persist(next);
    set(next);
  },
  completeOnboardingStep: (step) => {
    const next = { ...get(), onboardingStep: step };
    persist(next);
    set(next);
  },
  setTeam: (slug) => {
    const next = { ...get(), currentTeamSlug: slug };
    persist(next);
    set(next);
  },
  expireSession: () => {
    const next: Session = {
      ...defaultSession,
      destination: get().destination,
      sessionExpired: true,
    };
    persist(next);
    set(next);
  },
  signOut: () => {
    persist(defaultSession);
    set({ ...defaultSession });
  },
}));
