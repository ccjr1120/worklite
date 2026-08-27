import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '@/api/client';
import { useWorkspaceSettingsQuery } from '@/api/queries';
import { queryClient } from '@/lib/query-client';
import { applyTheme, resolveTheme, type Appearance, type ResolvedTheme } from '@/lib/theme';

type ThemeContextValue = {
  appearance: Appearance;
  resolvedTheme: ResolvedTheme;
  setAppearance: (appearance: Appearance) => Promise<void>;
  applyAppearancePreference: (appearance: Appearance) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const settingsQuery = useWorkspaceSettingsQuery();
  const [appearance, setAppearanceState] = useState<Appearance>('system');
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(appearance));

  const applyAppearancePreference = useCallback((next: Appearance) => {
    setAppearanceState(next);
    setResolvedTheme(applyTheme(next));
  }, []);

  const setAppearance = useCallback(async (next: Appearance) => {
    const previous = appearance;
    applyAppearancePreference(next);
    try {
      const saved = await api.updateSettings({ appearance: next });
      queryClient.setQueryData(['settings'], saved);
      applyAppearancePreference(saved.appearance);
    } catch (error) {
      applyAppearancePreference(previous);
      throw error;
    }
  }, [appearance, applyAppearancePreference]);

  useEffect(() => {
    if (settingsQuery.data) applyAppearancePreference(settingsQuery.data.appearance);
  }, [applyAppearancePreference, settingsQuery.data]);

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
    () => ({ appearance, resolvedTheme, setAppearance, applyAppearancePreference }),
    [appearance, resolvedTheme, setAppearance, applyAppearancePreference],
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
