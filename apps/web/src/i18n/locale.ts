export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = 'en';

export const LOCALE_NATIVE_NAMES: Record<AppLocale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
};

const LOCALE_STORAGE_KEY = 'worklite.locale';

export function applyDocumentLocale(locale: AppLocale) {
  document.documentElement.lang = locale;
}

export function readStoredLocale(): AppLocale | null {
  if (typeof window === 'undefined') return null;
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  return SUPPORTED_LOCALES.includes(stored as AppLocale) ? stored as AppLocale : null;
}

export function storeLocale(locale: AppLocale) {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
}

export function removeStoredLocale() {
  window.localStorage.removeItem(LOCALE_STORAGE_KEY);
}

function normalizeLocale(candidate: string): AppLocale {
  const normalized = candidate.toLowerCase();
  if (normalized.startsWith('zh')) return 'zh-CN';
  if (normalized.startsWith('en')) return 'en';
  return DEFAULT_LOCALE;
}

export function detectBrowserLocale(): AppLocale {
  if (typeof navigator === 'undefined') return DEFAULT_LOCALE;
  for (const candidate of navigator.languages ?? [navigator.language]) {
    if (candidate) return normalizeLocale(candidate);
  }
  return DEFAULT_LOCALE;
}

export function resolveInitialLocale(): AppLocale {
  return readStoredLocale() ?? detectBrowserLocale();
}
