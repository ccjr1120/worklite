export const LOCALE_STORAGE_KEY = 'worklite.locale';

export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = 'en';

export const LOCALE_NATIVE_NAMES: Record<AppLocale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
};

const COMPATIBLE_LOCALE_MAP: Record<string, AppLocale> = {
  en: 'en',
  'en-us': 'en',
  'en-gb': 'en',
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-hans': 'zh-CN',
  'zh-hans-cn': 'zh-CN',
  'zh-sg': 'zh-CN',
};

export function isAppLocale(value: string): value is AppLocale {
  return SUPPORTED_LOCALES.includes(value as AppLocale);
}

export function normalizeLocale(value: string | null | undefined): AppLocale | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().replaceAll('_', '-').toLowerCase();
  if (!normalized) {
    return null;
  }

  if (COMPATIBLE_LOCALE_MAP[normalized]) {
    return COMPATIBLE_LOCALE_MAP[normalized];
  }

  const language = normalized.split('-')[0];
  return COMPATIBLE_LOCALE_MAP[language] ?? null;
}

export function readStoredLocale(): AppLocale | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return normalizeLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
}

export function detectBrowserLocale(): AppLocale | null {
  if (typeof navigator === 'undefined') {
    return null;
  }

  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate);
    if (locale) {
      return locale;
    }
  }

  return null;
}

export function resolveLocale(): AppLocale {
  return readStoredLocale() ?? detectBrowserLocale() ?? DEFAULT_LOCALE;
}

export function persistLocale(locale: AppLocale) {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
}

export function applyDocumentLocale(locale: AppLocale) {
  document.documentElement.lang = locale;
}
