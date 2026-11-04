import type { WorkliteFixedNavigationTarget, WorkliteNavigationTarget } from '@worklite/contracts';

export const WORKLITE_NAVIGATION_ROUTES = {
  home: '/agents',
  chat: '/chat',
  skills: '/skills',
  'mcp-servers': '/mcp-servers',
  'model-providers': '/model-providers',
  logs: '/logs',
  agents: '/agents',
  'settings-appearance': '/settings/appearance',
  'settings-usage': '/settings/usage',
  'settings-audit-log': '/settings/audit-log',
} as const satisfies Record<WorkliteFixedNavigationTarget, string>;

// Workflow ids use the `wf_<uuid>` shape; names are resolved before this target reaches the API.
const AGENT_TARGET_PATTERN = /^\/agents\/[A-Za-z0-9_-]+$/;

export function isWorkliteNavigationTarget(value: unknown): value is WorkliteNavigationTarget {
  return typeof value === 'string' && (typeof WORKLITE_NAVIGATION_ROUTES[value as WorkliteFixedNavigationTarget] === 'string' || AGENT_TARGET_PATTERN.test(value));
}

export function resolveWorkliteNavigationRoute(target: WorkliteNavigationTarget): string | null {
  if (!isWorkliteNavigationTarget(target)) return null;
  return WORKLITE_NAVIGATION_ROUTES[target as WorkliteFixedNavigationTarget] ?? (AGENT_TARGET_PATTERN.test(target) ? target : null);
}
