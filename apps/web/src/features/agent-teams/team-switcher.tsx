import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { AgentTeamRunStatus, AgentTeamView } from '@worklite/contracts';
import { useAgentTeamRecordsQuery, useAgentTeamsQuery } from '@/api/queries';
import { focusRing } from '@/components/ui/interaction';
import { cn } from '@/lib/utils';

// `/agent-teams` and the legacy `/agent-team-config` path open the existing Company Project Team.
export const DEFAULT_AGENT_TEAM_ID = 'agent_team_bmad_tea';

const ACTIVE_RUN_STATUSES: AgentTeamRunStatus[] = ['running', 'waiting_for_input', 'paused'];

type TeamView = 'records' | 'config';

export function TeamSwitcher({ teamId, view }: { teamId: string; view: TeamView }) {
  const { t } = useTranslation('agentTeams');
  const query = useAgentTeamsQuery();
  if (!query.data?.length) return null;

  return (
    <nav aria-label={t('switcher.label')} className="grid gap-3 md:grid-cols-2">
      {query.data.map((team) => <TeamCard key={team.id} team={team} selected={team.id === teamId} view={view} />)}
    </nav>
  );
}

function TeamCard({ team, selected, view }: { team: AgentTeamView; selected: boolean; view: TeamView }) {
  const { t } = useTranslation('agentTeams');
  // Each card reuses the per-Team Run-summary query, so the selected Team's counts share the records request.
  const runs = useAgentTeamRecordsQuery(team.id);
  const count = (statuses: AgentTeamRunStatus[]) => runs.data ? runs.data.filter((run) => statuses.includes(run.status)).length : '–';
  const focus = t(`focus.${team.id}` as never, { defaultValue: '' });

  return (
    <Link
      to={view === 'config' ? '/agent-teams/$teamId/config' : '/agent-teams/$teamId'}
      params={{ teamId: team.id }}
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'wl-press block rounded-xl border p-4 shadow-xs transition-colors',
        selected ? 'border-brand bg-brand-subtle' : 'border-border bg-surface hover:bg-surface-subtle',
        focusRing,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold break-words">{team.name}</span>
        {focus ? <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-xs text-muted-foreground">{focus}</span> : null}
        {selected ? <span className="ml-auto text-xs font-medium text-brand-text">{t('switcher.current')}</span> : null}
      </div>
      {team.description ? <p className="mt-1.5 text-[13px] break-words text-muted-foreground">{team.description}</p> : null}
      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div className="flex gap-1"><dt>{t('switcher.maxConcurrentRuns')}</dt><dd className="tabular-nums text-foreground">{team.maxConcurrentRuns}</dd></div>
        <div className="flex gap-1"><dt>{t('switcher.activeRuns')}</dt><dd className="tabular-nums text-foreground">{count(ACTIVE_RUN_STATUSES)}</dd></div>
        <div className="flex gap-1"><dt>{t('switcher.queuedRuns')}</dt><dd className="tabular-nums text-foreground">{count(['queued'])}</dd></div>
      </dl>
    </Link>
  );
}
