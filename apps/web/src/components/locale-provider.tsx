import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { api } from '@/api/client';
import { useWorkspaceSettingsQuery } from '@/api/queries';
import { i18n } from '@/i18n/config';
import {
  applyDocumentLocale,
  DEFAULT_LOCALE,
  readStoredLocale,
  removeStoredLocale,
  resolveInitialLocale,
  storeLocale,
  type AppLocale,
} from '@/i18n/locale';
import { queryClient } from '@/lib/query-client';

type LocaleContextValue = {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => Promise<void>;
  applyLocalePreference: (locale: AppLocale) => void;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const settingsQuery = useWorkspaceSettingsQuery();
  const [locale, setLocaleState] = useState<AppLocale>(resolveInitialLocale);

  const applyLocalePreference = useCallback((next: AppLocale) => {
    applyDocumentLocale(next);
    setLocaleState(next);
    void i18n.changeLanguage(next);
  }, []);

  const setLocale = useCallback(async (next: AppLocale) => {
    const previous = locale;
    const previousStored = readStoredLocale();
    storeLocale(next);
    applyLocalePreference(next);
    try {
      const saved = await api.updateSettings({ locale: next });
      queryClient.setQueryData(['settings'], saved);
      applyLocalePreference(saved.locale);
    } catch (error) {
      if (previousStored) storeLocale(previousStored);
      else removeStoredLocale();
      applyLocalePreference(previous);
      throw error;
    }
  }, [applyLocalePreference, locale]);

  useEffect(() => {
    const stored = readStoredLocale();
    if (stored) {
      if (stored !== locale) applyLocalePreference(stored);
      return;
    }
    // The seeded English setting is not an explicit choice, so it must not erase a
    // browser-derived locale before the user has selected a language.
    const preference = settingsQuery.data?.locale;
    if (preference && preference !== DEFAULT_LOCALE && preference !== locale) {
      applyLocalePreference(preference);
    }
  }, [applyLocalePreference, locale, settingsQuery.data]);

  useEffect(() => {
    applyDocumentLocale(locale);
    if (i18n.language !== locale) {
      void i18n.changeLanguage(locale);
    }
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale, applyLocalePreference }), [locale, setLocale, applyLocalePreference]);

  return (
    <I18nextProvider i18n={i18n}>
      <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
    </I18nextProvider>
  );
}

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error('useLocale must be used within LocaleProvider');
  }
  return context;
}
