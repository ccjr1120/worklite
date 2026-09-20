import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '@/i18n/config';
import { applyDocumentLocale, DEFAULT_LOCALE, type AppLocale } from '@/i18n/locale';

type LocaleContextValue = {
  locale: AppLocale;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  useEffect(() => { applyDocumentLocale(); }, []);
  const value = useMemo(() => ({ locale: DEFAULT_LOCALE }), []);
  return <I18nextProvider i18n={i18n}><LocaleContext.Provider value={value}>{children}</LocaleContext.Provider></I18nextProvider>;
}

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('useLocale must be used within LocaleProvider');
  return context;
}
