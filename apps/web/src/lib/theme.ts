export type Appearance = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const APPEARANCE_STORAGE_KEY = 'worklite.appearance';

export function getStoredAppearance(): Appearance {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function storeAppearance(appearance: Appearance) {
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
  } catch {
    // The applied theme still works when storage is unavailable.
  }
}

function getPreferredTheme(): ResolvedTheme {
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
