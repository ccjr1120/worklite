import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { api } from '@/api/client';
import { useWorkspaceSettingsQuery } from '@/api/queries';
import { i18n } from '@/i18n/config';
import { applyDocumentLocale, DEFAULT_LOCALE, type AppLocale } from '@/i18n/locale';
import { queryClient } from '@/lib/query-client';

type LocaleContextValue = {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => Promise<void>;
  applyLocalePreference: (locale: AppLocale) => void;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const settingsQuery = useWorkspaceSettingsQuery();
  const [locale, setLocaleState] = useState<AppLocale>(DEFAULT_LOCALE);

  const applyLocalePreference = useCallback((next: AppLocale) => {
    applyDocumentLocale(next);
    setLocaleState(next);
    void i18n.changeLanguage(next);
  }, []);

  const setLocale = useCallback(async (next: AppLocale) => {
    const previous = locale;
    applyLocalePreference(next);
    try {
      const saved = await api.updateSettings({ locale: next });
      queryClient.setQueryData(['settings'], saved);
      applyLocalePreference(saved.locale);
    } catch (error) {
      applyLocalePreference(previous);
      throw error;
    }
  }, [applyLocalePreference, locale]);

  useEffect(() => {
    if (settingsQuery.data) applyLocalePreference(settingsQuery.data.locale);
  }, [applyLocalePreference, settingsQuery.data]);

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
