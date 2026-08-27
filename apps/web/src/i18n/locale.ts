export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = 'en';

export const LOCALE_NATIVE_NAMES: Record<AppLocale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
};

export function applyDocumentLocale(locale: AppLocale) {
  document.documentElement.lang = locale;
}
