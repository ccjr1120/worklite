import type { WorkliteFixedNavigationTarget, WorkliteNavigationTarget } from '@worklite/contracts';

export const WORKLITE_NAVIGATION_ROUTES = {
  home: '/home',
  chat: '/chat',
  skills: '/skills',
  'mcp-servers': '/mcp-servers',
  'model-providers': '/model-providers',
  logs: '/logs',
  workflows: '/workflows',
  'settings-appearance': '/settings/appearance',
  'settings-usage': '/settings/usage',
  'settings-audit-log': '/settings/audit-log',
} as const satisfies Record<WorkliteFixedNavigationTarget, string>;

// Workflow ids use the `wf_<uuid>` shape; names are resolved before this target reaches the API.
const WORKFLOW_EDITOR_TARGET_PATTERN = /^\/workflows\/[A-Za-z0-9_-]+$/;

export function isWorkliteNavigationTarget(value: unknown): value is WorkliteNavigationTarget {
  return typeof value === 'string' && (typeof WORKLITE_NAVIGATION_ROUTES[value as WorkliteFixedNavigationTarget] === 'string' || WORKFLOW_EDITOR_TARGET_PATTERN.test(value));
}

export function resolveWorkliteNavigationRoute(target: WorkliteNavigationTarget): string | null {
  if (!isWorkliteNavigationTarget(target)) return null;
  return WORKLITE_NAVIGATION_ROUTES[target as WorkliteFixedNavigationTarget] ?? (WORKFLOW_EDITOR_TARGET_PATTERN.test(target) ? target : null);
}
