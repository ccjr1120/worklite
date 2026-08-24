export const APPEARANCE_STORAGE_KEY = 'worklite.appearance';

export type Appearance = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export function readStoredAppearance(): Appearance {
  if (typeof window === 'undefined') {
    return 'system';
  }

  const stored = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    return stored;
  }

  return 'system';
}

export function getPreferredTheme(): ResolvedTheme {
  if (typeof window === 'undefined') {
    return 'light';
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveTheme(appearance: Appearance): ResolvedTheme {
  return appearance === 'system' ? getPreferredTheme() : appearance;
}

export function applyTheme(appearance: Appearance): ResolvedTheme {
  const resolved = resolveTheme(appearance);
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  return resolved;
}
