const SIDEBAR_COLLAPSED_STORAGE_KEY = 'worklite.sidebar.collapsed';

function readSidebarCollapsedPreference(): boolean | null {
  if (typeof window === 'undefined') return null;

  try {
    const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

function storeSidebarCollapsedPreference(collapsed: boolean): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // The toggle still works for this session when storage is unavailable.
  }
}

export { readSidebarCollapsedPreference, storeSidebarCollapsedPreference };
