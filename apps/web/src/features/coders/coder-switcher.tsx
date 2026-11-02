import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { CODER_ACTIVE_RUN_STATUSES, type AgentTeamRunStatus, type AgentTeamRunStatusCount, type AgentTeamView } from '@worklite/contracts';
import { useCoderRunStatusCountsQuery, useCodersQuery } from '@/api/queries';
import { focusRing } from '@/components/ui/interaction';
import { TruncatedText } from '@/components/ui/truncated-text';
import { cn } from '@/lib/utils';

/** Executor cards for the configuration view; each links to the same configuration page of that executor. */
export function CoderSwitcher({ coderId }: { coderId: string }) {
  const { t } = useTranslation('coders');
  const query = useCodersQuery();
  // One grouped request serves every card.
  const counts = useCoderRunStatusCountsQuery();
  if (!query.data?.length) return null;

  return (
    <nav aria-label={t('switcher.label')} className="grid gap-3 md:grid-cols-2">
      {query.data.map((team) => <TeamCard key={team.id} team={team} selected={team.id === coderId} counts={counts.data} />)}
    </nav>
  );
}

function TeamCard({ team, selected, counts }: { team: AgentTeamView; selected: boolean; counts: AgentTeamRunStatusCount[] | undefined }) {
  const { t } = useTranslation('coders');
  const count = (statuses: readonly AgentTeamRunStatus[]) => counts
    ? counts.filter((row) => row.coderId === team.id && statuses.includes(row.status)).reduce((total, row) => total + row.count, 0)
    : '–';
  const focus = t(`focus.${team.id}` as never, { defaultValue: '' });

  return (
    <Link
      to="/coding/$coderId/config"
      params={{ coderId: team.id }}
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
        <div className="flex gap-1"><dt>{t('switcher.activeRuns')}</dt><dd className="tabular-nums text-foreground">{count(CODER_ACTIVE_RUN_STATUSES)}</dd></div>
        <div className="flex gap-1"><dt>{t('switcher.queuedRuns')}</dt><dd className="tabular-nums text-foreground">{count(['queued'])}</dd></div>
      </dl>
    </Link>
  );
}
