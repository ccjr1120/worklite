import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Search, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentTeamRunStatus, AgentTeamRunSummary } from '@worklite/contracts';
import { useAgentTeamRecordsQuery, useAgentTeamsQuery } from '@/api/queries';
import { ErrorState } from '@/components/error-state';
import { PageContainer, PageHeading } from '@/components/page-heading';
import { StatusDot, toStatusKey } from '@/components/status-badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { TruncatedText } from '@/components/ui/truncated-text';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { focusRing } from '@/components/ui/interaction';
import { toSingleLine } from '@/lib/single-line';

const RUN_STATUSES: AgentTeamRunStatus[] = ['running', 'waiting_for_input', 'queued', 'paused', 'succeeded', 'failed', 'cancelled'];
const SKELETON_ROWS = 8;

// Fixed row geometry: status, title and time never wrap, so rows keep one height whatever the Run intent holds.
const rowGrid = 'grid h-12 grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3 px-4 sm:grid-cols-[5.5rem_minmax(0,1fr)_9.5rem]';

type StatusFilter = AgentTeamRunStatus | 'all';

/** Newest first; a Run matches when its single-line title contains the keyword. */
export function filterRuns(runs: AgentTeamRunSummary[], status: StatusFilter, keyword: string): AgentTeamRunSummary[] {
  const needle = keyword.trim().toLowerCase();
  return runs
    .filter((run) => (status === 'all' || run.status === status) && (!needle || toSingleLine(run.intent).toLowerCase().includes(needle)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function RunListSkeleton() {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-surface" role="status" aria-busy="true">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <li key={index} className={rowGrid}><Skeleton className="h-4 w-16" /><Skeleton className="h-4 w-2/3" /><Skeleton className="hidden h-4 w-28 justify-self-end sm:block" /></li>
      ))}
    </ul>
  );
}

export function TeamRecords({ teamId }: { teamId: string }) {
  const { t } = useTranslation('agentTeams');
  const { locale } = useLocale();
  const query = useAgentTeamRecordsQuery(teamId);
  const teamName = useAgentTeamsQuery().data?.find((team) => team.id === teamId)?.name;
  const [status, setStatus] = useState<StatusFilter>('all');
  const [keyword, setKeyword] = useState('');
  const runs = useMemo(() => filterRuns(query.data ?? [], status, keyword), [query.data, status, keyword]);
  const crumbs = [{ label: t('title') }, ...(teamName ? [{ label: teamName }] : [])];
  const loading = query.isPending;

  return (
    <PageContainer width="detail">
      <WorkspaceChrome crumbs={crumbs} />
      <PageHeading
        title={teamName ?? t('title')}
        description={t('records.description')}
        actions={<Link to="/agent-teams/$teamId/config" params={{ teamId }} className={`inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-3 text-sm font-medium hover:bg-muted ${focusRing}`}><Settings className="size-4" aria-hidden="true" />{t('config.viewConfig')}</Link>}
      />
      <div className="flex flex-col gap-2 sm:flex-row" role="search" aria-label={t('records.filters.label')}>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input className="pl-9" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={t('records.filters.keyword')} aria-label={t('records.filters.keyword')} disabled={loading} />
        </div>
        <Select value={status} onValueChange={(value) => setStatus(value as StatusFilter)} disabled={loading}>
          <SelectTrigger className="sm:w-44" aria-label={t('records.filters.status')}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('records.filters.allStatuses')}</SelectItem>
            {RUN_STATUSES.map((value) => <SelectItem key={value} value={value}>{t(`run.status.${value}`)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {loading ? <RunListSkeleton /> : query.isError ? (
        <ErrorState title={t('records.title')} description={t('records.loadFailed')} onAction={() => void query.refetch()} />
      ) : !runs.length ? (
        <div className="flex h-12 items-center justify-center rounded-xl border border-dashed border-border px-4 text-sm text-muted-foreground">
          <TruncatedText text={query.data.length ? t('records.noMatch') : t('records.empty')} />
          {query.data.length ? null : <Link to="/chat" className="ml-2 shrink-0 whitespace-nowrap text-brand-text underline underline-offset-4">{t('records.openChat')}</Link>}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {runs.map((run) => {
            const label = t(`run.status.${run.status}`);
            return (
              <li key={run.id}>
                <Link to="/agent-team-runs/$runId" params={{ runId: run.id }} className={`${rowGrid} rounded-lg hover:bg-muted ${focusRing}`}>
                  <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"><StatusDot status={toStatusKey(run.status)} /><span className="truncate">{label}</span></span>
                  <TruncatedText text={toSingleLine(run.intent) || run.id} title={run.intent} className="text-sm font-medium" />
                  <time dateTime={run.createdAt} className="hidden truncate whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground sm:block">{formatDateTime(run.createdAt, locale)}</time>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </PageContainer>
  );
}
