import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { AgentTeamRunStatus, AgentTeamView } from '@worklite/contracts';
import { useAgentTeamRecordsQuery, useAgentTeamsQuery } from '@/api/queries';
import { focusRing } from '@/components/ui/interaction';
import { TruncatedText } from '@/components/ui/truncated-text';
import { cn } from '@/lib/utils';

// `/executor-categories` and the legacy `/agent-team-config` path open the existing Company Project team.
export const DEFAULT_EXECUTOR_CATEGORY_ID = 'agent_team_bmad_tea';

const ACTIVE_RUN_STATUSES: AgentTeamRunStatus[] = ['running', 'waiting_for_input', 'paused'];

/** Executor cards for the configuration view; each links to the same configuration page of that executor. */
export function TeamSwitcher({ executorCategoryId }: { executorCategoryId: string }) {
  const { t } = useTranslation('executorCategories');
  const query = useAgentTeamsQuery();
  if (!query.data?.length) return null;

  return (
    <nav aria-label={t('switcher.label')} className="grid gap-3 md:grid-cols-2">
      {query.data.map((team) => <TeamCard key={team.id} team={team} selected={team.id === executorCategoryId} />)}
    </nav>
  );
}

function TeamCard({ team, selected }: { team: AgentTeamView; selected: boolean }) {
  const { t } = useTranslation('executorCategories');
  // Each card reuses the per-executor Run-summary query, so the selected executor's counts share the records request.
  const runs = useAgentTeamRecordsQuery(team.id);
  const count = (statuses: AgentTeamRunStatus[]) => runs.data ? runs.data.filter((run) => statuses.includes(run.status)).length : '–';
  const focus = t(`focus.${team.id}` as never, { defaultValue: '' });

  return (
    <Link
      to="/executor-categories/$executorCategoryId/config"
      params={{ executorCategoryId: team.id }}
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'wl-press block rounded-xl border p-4 shadow-xs transition-colors',
        selected ? 'border-brand bg-brand-subtle' : 'border-border bg-surface hover:bg-surface-subtle',
        focusRing,
      )}
    >
      <div className="flex items-center gap-2">
        <TruncatedText text={team.name} className="text-sm font-semibold" />
        {focus ? <span className="shrink-0 whitespace-nowrap rounded-full bg-surface-subtle px-2 py-0.5 text-xs text-muted-foreground">{focus}</span> : null}
        {selected ? <span className="ml-auto shrink-0 whitespace-nowrap text-xs font-medium text-brand-text">{t('switcher.current')}</span> : null}
      </div>
      {team.description ? <TruncatedText as="p" text={team.description} className="mt-1.5 text-[13px] text-muted-foreground" /> : null}
      <dl className="mt-3 flex gap-x-4 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
        <div className="flex gap-1"><dt>{t('switcher.maxConcurrentRuns')}</dt><dd className="tabular-nums text-foreground">{team.maxConcurrentRuns}</dd></div>
        <div className="flex gap-1"><dt>{t('switcher.activeRuns')}</dt><dd className="tabular-nums text-foreground">{count(ACTIVE_RUN_STATUSES)}</dd></div>
        <div className="flex gap-1"><dt>{t('switcher.queuedRuns')}</dt><dd className="tabular-nums text-foreground">{count(['queued'])}</dd></div>
      </dl>
    </Link>
  );
}
