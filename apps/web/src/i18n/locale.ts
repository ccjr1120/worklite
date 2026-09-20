export type AppLocale = 'zh-CN';
export const DEFAULT_LOCALE: AppLocale = 'zh-CN';

export function applyDocumentLocale() {
  document.documentElement.lang = DEFAULT_LOCALE;
}
