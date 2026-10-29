import { useMemo, useState, useCallback } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { Search, Settings, ChevronDown, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentTeamRunStatus } from '@worklite/contracts';
import { useAgentTeamRunListQuery, useAgentTeamsQuery } from '@/api/queries';
import { ErrorState } from '@/components/error-state';
import { PageContainer, PageHeading } from '@/components/page-heading';
import { StatusDot, toStatusKey } from '@/components/status-badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { TruncatedText } from '@/components/ui/truncated-text';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime, formatDuration } from '@/i18n/format';
import { focusRing } from '@/components/ui/interaction';
import { toSingleLine } from '@/lib/single-line';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

const RUN_STATUSES: AgentTeamRunStatus[] = ['running', 'waiting_for_input', 'queued', 'paused', 'succeeded', 'failed', 'cancelled'];
const SKELETON_ROWS = 8;

// Fixed row geometry for flat list with inline team, intent, status, directory, times, duration
const rowGrid = 'grid h-14 grid-cols-[minmax(0,1fr)_10rem_8rem_12rem] items-center gap-2 px-4 sm:grid-cols-[8rem_minmax(0,1fr)_8rem_12rem_10rem_12rem_8rem]';

function formatDurationFromDates(createdAt: string, finishedAt: string | null): string {
  const start = new Date(createdAt);
  const end = finishedAt ? new Date(finishedAt) : new Date();
  const durationMs = end.getTime() - start.getTime();
  return formatDuration(durationMs);
}

function RunListSkeleton() {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-surface" role="status" aria-busy="true">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <li key={index} className={rowGrid}>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="hidden h-4 w-24 sm:block" />
          <Skeleton className="hidden h-4 w-28 sm:block" />
          <Skeleton className="hidden h-4 w-12 sm:block" />
        </li>
      ))}
    </ul>
  );
}

interface TeamFilterProps {
  selectedTeamIds: string[];
  onTeamsChange: (executorCategoryIds: string[]) => void;
  disabled?: boolean;
}

function TeamFilterPopover({ selectedTeamIds, onTeamsChange, disabled }: TeamFilterProps) {
  const { t } = useTranslation('executors');
  const teamsData = useAgentTeamsQuery().data ?? [];

  const handleTeamToggle = (executorCategoryId: string) => {
    onTeamsChange(
      selectedTeamIds.includes(executorCategoryId)
        ? selectedTeamIds.filter(id => id !== executorCategoryId)
        : [...selectedTeamIds, executorCategoryId]
    );
  };

  const handleClear = () => {
    onTeamsChange([]);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="gap-2"
          disabled={disabled}
        >
          <span>{t('records.filters.executor')}</span>
          {selectedTeamIds.length > 0 && (
            <span className="inline-flex items-center justify-center min-w-5 rounded-full bg-brand text-xs font-medium text-brand-text">
              {selectedTeamIds.length}
            </span>
          )}
          <ChevronDown className="size-4" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="start">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t('records.filters.executor')}</span>
            {selectedTeamIds.length > 0 && (
              <button
                onClick={handleClear}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {t('records.filters.clearAll')}
              </button>
            )}
          </div>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {teamsData.map((team) => (
              <label key={team.id} className="flex items-center gap-2 cursor-pointer hover:bg-muted rounded px-2 py-1">
                <input
                  type="checkbox"
                  checked={selectedTeamIds.includes(team.id)}
                  onChange={() => handleTeamToggle(team.id)}
                  className="rounded"
                />
                <span className="text-sm">{team.name}</span>
              </label>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function TeamRecords({ executorId: executorCategoryId }: { executorId: string }) {
  const { t } = useTranslation('executors');
  const { locale } = useLocale();
  const search = useSearch({ from: '/' });

  // Parse teams filter from URL search params
  const teamsParam = search.teams as string | undefined;
  const initialTeamIds = useMemo(() => {
    if (teamsParam) {
      return teamsParam.split(',').filter(Boolean);
    }
    return [executorCategoryId]; // Default to current team
  }, [teamsParam, executorCategoryId]);

  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>(initialTeamIds);
  const [keyword, setKeyword] = useState('');

  const handleTeamsChange = useCallback((executorCategoryIds: string[]) => {
    setSelectedTeamIds(executorCategoryIds);
    // Update URL with teams filter
    const params = new URLSearchParams(window.location.search);
    if (executorCategoryIds.length > 0) {
      params.set('teams', executorCategoryIds.join(','));
    } else {
      params.delete('teams');
    }
    const newUrl = `${window.location.pathname}${params.size > 0 ? `?${params.toString()}` : ''}`;
    window.history.replaceState(null, '', newUrl);
  }, []);

  const query = useAgentTeamRunListQuery(selectedTeamIds);
  const teamsData = useAgentTeamsQuery().data ?? [];

  const crumbs = [{ label: 'Coding' }];
  const loading = query.isPending;

  // Filter runs by keyword (runs are already paginated from API)
  const filteredRuns = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return query.data?.pages.flatMap(page => page.items).filter(run =>
      !needle || toSingleLine(run.intent).toLowerCase().includes(needle)
    ) ?? [];
  }, [query.data?.pages, keyword]);

  const total = query.data?.pages[0]?.total ?? 0;
  const hasNextPage = query.hasNextPage;
  const isEmpty = !loading && filteredRuns.length === 0;

  return (
    <PageContainer width="detail">
      <WorkspaceChrome crumbs={crumbs} />
      <PageHeading
        title="Coding"
        description={t('records.description')}
        actions={<Link to="/executors/$executorId/config" params={{ executorId: executorCategoryId }} className={`inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-3 text-sm font-medium hover:bg-muted ${focusRing}`}><Settings className="size-4" aria-hidden="true" />{t('config.viewConfig')}</Link>}
      />
      <div className="space-y-4">
        {/* Filters */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              className="pl-9"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder={t('records.filters.keyword')}
              aria-label={t('records.filters.keyword')}
              disabled={loading}
            />
          </div>
          <TeamFilterPopover
            selectedTeamIds={selectedTeamIds}
            onTeamsChange={handleTeamsChange}
            disabled={loading}
          />
        </div>

        {/* Total count and status */}
        <div className="text-sm text-muted-foreground">
          {t('records.total', { count: total })}
        </div>

        {/* List or empty state */}
        {loading ? (
          <RunListSkeleton />
        ) : query.isError ? (
          <ErrorState title={t('records.title')} description={t('records.loadFailed')} onAction={() => void query.refetch()} />
        ) : isEmpty ? (
          <div className="flex h-24 items-center justify-center rounded-xl border border-dashed border-border px-4 text-sm text-muted-foreground">
            <TruncatedText text={query.data?.pages[0]?.items.length ? t('records.noMatch') : t('records.empty')} />
          </div>
        ) : (
          <>
            <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
              {filteredRuns.map((run) => {
                const label = t(`run.status.${run.status}`);
                const duration = formatDurationFromDates(run.createdAt, run.finishedAt);
                return (
                  <li key={run.id}>
                    <Link
                      to="/executor-runs/$runId"
                      params={{ runId: run.id }}
                      className={`${rowGrid} rounded-lg hover:bg-muted ${focusRing}`}
                    >
                      {/* Executor name captured when the Run was dispatched */}
                      <span className="hidden sm:flex text-xs font-medium text-foreground truncate">
                        {run.executorName}
                      </span>
                      {/* Status and intent */}
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                          <StatusDot status={toStatusKey(run.status)} />
                          <span className="truncate">{label}</span>
                        </span>
                        <TruncatedText
                          text={toSingleLine(run.intent) || run.id}
                          title={run.intent}
                          className="text-sm font-medium"
                        />
                      </div>
                      {/* Project directory - truncated */}
                      <div className="hidden sm:block">
                        <TruncatedText
                          text={run.projectDirectory}
                          title={run.projectDirectory}
                          className="text-xs text-muted-foreground"
                        />
                      </div>
                      {/* Created time */}
                      <time
                        dateTime={run.createdAt}
                        className="truncate whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground"
                      >
                        {formatDateTime(run.createdAt, locale)}
                      </time>
                      {/* Finished time - hidden on small screens */}
                      <time
                        dateTime={run.finishedAt ?? undefined}
                        className="hidden sm:block truncate whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground"
                      >
                        {run.finishedAt ? formatDateTime(run.finishedAt, locale) : '—'}
                      </time>
                      {/* Duration - hidden on small screens */}
                      <div className="hidden sm:block text-right text-xs tabular-nums text-muted-foreground">
                        {duration}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>

            {/* Load more button */}
            {hasNextPage && (
              <div className="flex justify-center pt-4">
                <Button
                  variant="outline"
                  onClick={() => query.fetchNextPage()}
                  disabled={query.isFetchingNextPage}
                >
                  {query.isFetchingNextPage ? t('records.loading') : t('records.loadMore')}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </PageContainer>
  );
}
