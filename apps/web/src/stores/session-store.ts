import { create } from 'zustand';

const SESSION_KEY = 'worklite.preferences';

export type OnboardingStep = 'provider' | 'first-agent' | 'complete';

export type Session = {
  hydrated: boolean;
  onboardingStep: OnboardingStep;
  destination: string | null;
};

const defaultSession: Session = { hydrated: false, onboardingStep: 'provider', destination: null };

function readLocalPreferences(): Pick<Session, 'destination' | 'onboardingStep'> {
  if (typeof window === 'undefined') return { destination: null, onboardingStep: 'provider' };
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return { destination: null, onboardingStep: 'provider' };
    const value = JSON.parse(raw) as Partial<Session>;
    return { destination: value.destination ?? null, onboardingStep: value.onboardingStep === 'first-agent' || value.onboardingStep === 'complete' ? value.onboardingStep : 'provider' };
  } catch {
    return { destination: null, onboardingStep: 'provider' };
  }
}

function persist(session: Session) {
  window.localStorage.setItem(SESSION_KEY, JSON.stringify({ destination: session.destination, onboardingStep: session.onboardingStep }));
}

type SessionStore = Session & {
  hydrate: () => Promise<void>;
  setDestination: (destination: string | null) => void;
  completeOnboardingStep: (step: OnboardingStep) => void;
};

export const useSessionStore = create<SessionStore>((set, get) => ({
  ...defaultSession,
  ...readLocalPreferences(),
  hydrate: async () => set({ ...get(), hydrated: true }),
  setDestination: (destination) => {
    const next = { ...get(), destination };
    persist(next);
    set(next);
  },
  completeOnboardingStep: (step) => {
    const next = { ...get(), onboardingStep: step };
    persist(next);
    set(next);
  },
}));
