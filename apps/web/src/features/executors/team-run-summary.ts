import type { TFunction } from 'i18next';
import type { AgentTeamRunCurrentView, AgentTeamRunView } from '@worklite/contracts';

type RoleIdentity = { role: string; roleName: string | null };

// Custom roles carry a generated id, so their captured display name wins over the built-in label.
export function teamRoleLabel(tTeams: TFunction<'executors'>, task: RoleIdentity): string {
  return task.roleName ?? tTeams(`role.${task.role.replaceAll('-', '_')}` as never, { defaultValue: task.role });
}

// Collapsed-card role label: the single active role, or a count when Developer lanes (or several
// roles) run in parallel.
export function teamCurrentLabel(t: TFunction<'assistant'>, tTeams: TFunction<'executors'>, current: AgentTeamRunCurrentView): string {
  const role = teamRoleLabel(tTeams, current);
  if (current.activeCount <= 1) return role;
  return current.activeRoleCount > 1
    ? t('teamRun.activeRoles', { count: current.activeCount })
    : t('teamRun.parallelRole', { role, count: current.activeCount });
}

export function isSettledTeamRun(run: Pick<AgentTeamRunView, 'status'>): boolean {
  return run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled';
}

// Same minute-granular wording as the project task card.
export function formatElapsed(t: TFunction<'assistant'>, fromIso: string | null, toMs: number): string | null {
  const from = fromIso ? Date.parse(fromIso) : Number.NaN;
  if (!Number.isFinite(from) || !Number.isFinite(toMs)) return null;
  const minutes = Math.max(0, Math.floor((toMs - from) / 60_000));
  if (minutes < 1) return t('codex.elapsedLessThanMinute');
  if (minutes < 60) return t('codex.elapsedMinutes', { count: minutes });
  if (minutes < 24 * 60) return t('codex.elapsedHours', { count: Math.floor(minutes / 60), remainder: minutes % 60 });
  return t('codex.elapsedDays', { count: Math.floor(minutes / (24 * 60)), remainder: Math.floor((minutes % (24 * 60)) / 60) });
}
