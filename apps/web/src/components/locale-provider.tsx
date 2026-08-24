import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '@/i18n/config';
import {
  applyDocumentLocale,
  persistLocale,
  resolveLocale,
  type AppLocale,
} from '@/i18n/locale';

type LocaleContextValue = {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(resolveLocale);

  const setLocale = useCallback((next: AppLocale) => {
    persistLocale(next);
    applyDocumentLocale(next);
    setLocaleState(next);
    void i18n.changeLanguage(next);
  }, []);

  useEffect(() => {
    applyDocumentLocale(locale);
    if (i18n.language !== locale) {
      void i18n.changeLanguage(locale);
    }
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);

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
