import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  APPEARANCE_STORAGE_KEY,
  applyTheme,
  readStoredAppearance,
  resolveTheme,
  type Appearance,
  type ResolvedTheme,
} from '@/lib/theme';

type ThemeContextValue = {
  appearance: Appearance;
  resolvedTheme: ResolvedTheme;
  setAppearance: (appearance: Appearance) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearanceState] = useState<Appearance>(readStoredAppearance);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(appearance));

  const setAppearance = useCallback((next: Appearance) => {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, next);
    setAppearanceState(next);
    setResolvedTheme(applyTheme(next));
  }, []);

  useEffect(() => {
    setResolvedTheme(applyTheme(appearance));

    if (appearance !== 'system') {
      return;
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolvedTheme(applyTheme('system'));
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [appearance]);

  const value = useMemo(
    () => ({ appearance, resolvedTheme, setAppearance }),
    [appearance, resolvedTheme, setAppearance],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
}
