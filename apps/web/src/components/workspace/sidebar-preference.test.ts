import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSidebarCollapsedPreference, storeSidebarCollapsedPreference } from './sidebar-preference';

const STORAGE_KEY = 'worklite.sidebar.collapsed';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('sidebar collapsed preference', () => {
  it('has no preference before the user toggles the sidebar', () => {
    expect(readSidebarCollapsedPreference()).toBeNull();
  });

  it('persists both collapsed and expanded states', () => {
    storeSidebarCollapsedPreference(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true');
    expect(readSidebarCollapsedPreference()).toBe(true);

    storeSidebarCollapsedPreference(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('false');
    expect(readSidebarCollapsedPreference()).toBe(false);
  });

  it('ignores values it does not recognize', () => {
    window.localStorage.setItem(STORAGE_KEY, 'collapsed');

    expect(readSidebarCollapsedPreference()).toBeNull();
  });
});
