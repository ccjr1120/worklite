export type Appearance = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

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
