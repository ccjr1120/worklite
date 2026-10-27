// The web search key is deployment environment configuration, not a platform UI
// setting: WorkLite no longer stores it, and nothing reads it back out over the
// API. A Skill that brings its own search credential sets one of these variables
// for the API process instead of registering a platform-level provider.
const WEB_SEARCH_API_KEY_ENV_KEYS = ['WORKLITE_WEB_SEARCH_API_KEY', 'VOLCENGINE_SEARCH_API_KEY'] as const;

export const WEB_SEARCH_API_KEY_ENV_KEY = WEB_SEARCH_API_KEY_ENV_KEYS[0];

export function readWebSearchApiKey(): string | null {
  for (const key of WEB_SEARCH_API_KEY_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return null;
}
