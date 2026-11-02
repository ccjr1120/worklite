import { ArrowDown, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiRequestLogList, ApiRequestLogStatusClass, ApiRequestRouteStat } from '@worklite/contracts';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime, formatNumber } from '@/i18n/format';
import { useApiRequestLogStatsQuery, useApiRequestLogsQuery } from '@/api/queries';
import { api } from '@/api/client';
import { cn } from '@/lib/utils';

type ApiRequestLogFilters = {
  method?: string;
  route?: string;
  minDurationMs?: number;
  statusClass?: ApiRequestLogStatusClass;
};

type SortKey = 'p95Ms' | 'avgMs' | 'maxMs' | 'count' | 'errorCount';

const SORT_KEYS: SortKey[] = ['count', 'avgMs', 'p95Ms', 'maxMs', 'errorCount'];
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;

function formatBytes(value: number | null, locale: ReturnType<typeof useLocale>['locale']): string {
  if (value === null) return '—';
  if (value < 1024) return `${formatNumber(value, locale)} B`;
  if (value < 1024 * 1024) return `${formatNumber(Math.round(value / 102.4) / 10, locale)} KB`;
  return `${formatNumber(Math.round(value / (1024 * 102.4)) / 10, locale)} MB`;
}

function statusTone(status: number): string {
  if (status >= 500) return 'text-danger';
  if (status >= 400) return 'text-warning';
  return 'text-muted-foreground';
}

function RouteStats({ routes, selectedRoute, onSelectRoute }: { routes: ApiRequestRouteStat[]; selectedRoute?: string; onSelectRoute: (route: ApiRequestRouteStat) => void }) {
  const { t } = useTranslation('logs');
  const { locale } = useLocale();
  const [sort, setSort] = useState<SortKey>('p95Ms');
  const sorted = useMemo(() => [...routes].sort((left, right) => right[sort] - left[sort]), [routes, sort]);

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full min-w-[720px] text-left text-[13px]">
        <caption className="sr-only">{t('api.stats.title')}</caption>
        <thead className="border-b border-border bg-background text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">{t('api.columns.route')}</th>
            {SORT_KEYS.map((key) => (
              <th key={key} scope="col" className="px-3 py-2 text-right font-medium" aria-sort={sort === key ? 'descending' : 'none'}>
                <button type="button" onClick={() => setSort(key)} className={cn('inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45', sort === key && 'text-foreground')}>
                  {t(`api.columns.${key}` as never)}
                  {sort === key ? <ArrowDown className="size-3" aria-hidden="true" /> : null}
                </button>
              </th>
            ))}
            <th scope="col" className="px-3 py-2 text-right font-medium">{t('api.columns.avgBytes')}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const selected = selectedRoute === row.route;
            return (
              <tr key={`${row.method} ${row.route}`} className={cn('border-b border-border last:border-0', selected && 'bg-brand-subtle')}>
                <td className="px-4 py-2">
                  <button type="button" onClick={() => onSelectRoute(row)} aria-pressed={selected} aria-label={t('api.stats.filterRoute', { method: row.method, route: row.route })} className="flex min-w-0 items-center gap-2 rounded text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45">
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{row.method}</span>
                    <span className="truncate font-mono text-xs">{row.route}</span>
                  </button>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.count, locale)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.avgMs, locale)} ms</td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">{formatNumber(row.p95Ms, locale)} ms</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.maxMs, locale)} ms</td>
                <td className={cn('px-3 py-2 text-right tabular-nums', row.errorCount ? 'text-danger' : 'text-muted-foreground')}>{formatNumber(row.errorCount, locale)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{formatBytes(row.avgBytes, locale)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ApiRequestLogs({ from, to, filters, onFiltersChange }: { from: string; to: string; filters: ApiRequestLogFilters; onFiltersChange: (next: ApiRequestLogFilters) => void }) {
  const { t } = useTranslation(['logs', 'common']);
  const { locale } = useLocale();
  const [pages, setPages] = useState<ApiRequestLogList[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [minDurationText, setMinDurationText] = useState(filters.minDurationMs === undefined ? '' : String(filters.minDurationMs));
  const statsQuery = useApiRequestLogStatsQuery({ from, to });
  const logsQuery = useApiRequestLogsQuery({ ...filters, from, to });
  const hasFilters = Boolean(filters.method || filters.route || filters.minDurationMs !== undefined || filters.statusClass);

  // Accumulated pages answer the previous question, so any new range or filter discards them.
  useEffect(() => {
    setPages([]);
  }, [from, to, filters.method, filters.route, filters.minDurationMs, filters.statusClass]);

  useEffect(() => {
    setMinDurationText(filters.minDurationMs === undefined ? '' : String(filters.minDurationMs));
  }, [filters.minDurationMs]);

  const items = useMemo(() => [...(logsQuery.data?.items ?? []), ...pages.flatMap((page) => page.items)], [logsQuery.data, pages]);
  const nextCursor = pages.at(-1)?.nextCursor ?? logsQuery.data?.nextCursor ?? null;
  const retentionDays = logsQuery.data?.retentionDays ?? statsQuery.data?.retentionDays;

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.apiRequestLogs({ ...filters, from, to, cursor: nextCursor });
      setPages((current) => [...current, page]);
    } catch {
      // The Load more control stays available so the reader can retry.
    } finally {
      setLoadingMore(false);
    }
  }

  function applyMinDuration() {
    const trimmed = minDurationText.trim();
    const parsed = trimmed ? Number(trimmed) : undefined;
    if (parsed !== undefined && (!Number.isFinite(parsed) || parsed < 0)) return;
    if (parsed !== filters.minDurationMs) onFiltersChange({ ...filters, minDurationMs: parsed });
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="api-request-stats-title">
        <h2 id="api-request-stats-title" className="text-base font-semibold">{t('api.stats.title')}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {retentionDays !== undefined ? t('api.retention', { days: retentionDays }) : null} {t('api.stats.streamingExcluded')}
        </p>
        <div className="mt-3">
          {statsQuery.isLoading ? (
            <Skeleton className="h-48 w-full rounded-lg" />
          ) : statsQuery.isError ? (
            <ErrorState title={t('api.stats.title')} description={t('api.stats.error')} onAction={() => void statsQuery.refetch()} />
          ) : !statsQuery.data?.routes.length ? (
            <EmptyState title={t('api.emptyTitle')} description={t('api.emptyDescription')} />
          ) : (
            <RouteStats
              routes={statsQuery.data.routes}
              selectedRoute={filters.route}
              onSelectRoute={(row) => onFiltersChange(filters.route === row.route && filters.method === row.method ? { ...filters, route: undefined, method: undefined } : { ...filters, route: row.route, method: row.method })}
            />
          )}
        </div>
      </section>

      <section aria-labelledby="api-request-list-title">
        <h2 id="api-request-list-title" className="text-base font-semibold">{t('api.list.title')}</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select value={filters.method ?? 'all'} onValueChange={(value) => onFiltersChange({ ...filters, method: value === 'all' ? undefined : value })}>
            <SelectTrigger className="w-[150px]" aria-label={t('api.filters.method')}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('api.filters.method')}</SelectItem>
              {METHODS.map((method) => <SelectItem key={method} value={method}>{method}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.statusClass ?? 'all'} onValueChange={(value) => onFiltersChange({ ...filters, statusClass: value === 'all' ? undefined : value as ApiRequestLogStatusClass })}>
            <SelectTrigger className="w-[170px]" aria-label={t('requests.filters.statusClass')}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('requests.statusClass.all')}</SelectItem>
              <SelectItem value="success">{t('requests.statusClass.success')}</SelectItem>
              <SelectItem value="client_error">{t('requests.statusClass.clientError')}</SelectItem>
              <SelectItem value="server_error">{t('requests.statusClass.serverError')}</SelectItem>
            </SelectContent>
          </Select>
          <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); applyMinDuration(); }}>
            <Input
              type="number"
              min={0}
              inputMode="numeric"
              value={minDurationText}
              onChange={(event) => setMinDurationText(event.target.value)}
              onBlur={applyMinDuration}
              placeholder={t('api.filters.minDuration')}
              aria-label={t('api.filters.minDuration')}
              className="w-[170px]"
            />
          </form>
          {filters.route ? (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-subtle px-2 py-1 font-mono text-xs">
              {`${t('api.filters.route')}: ${filters.method ? `${filters.method} ` : ''}${filters.route}`}
            </span>
          ) : null}
          {hasFilters ? <Button type="button" variant="ghost" size="compact" onClick={() => onFiltersChange({})}>{t('common:actions.clearFilters')}</Button> : null}
        </div>

        <div className="mt-3">
          {logsQuery.isLoading ? (
            <div role="status" aria-busy="true" aria-live="polite" className="grid gap-2">
              <span className="sr-only">{t('api.list.title')}</span>
              {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-10 w-full rounded-md" />)}
            </div>
          ) : logsQuery.isError ? (
            <ErrorState title={t('api.list.title')} description={t('api.list.error')} onAction={() => void logsQuery.refetch()} />
          ) : items.length === 0 ? (
            hasFilters
              ? <EmptyState title={t('requests.noMatches.title')} description={t('requests.noMatches.description')} actionLabel={t('common:actions.clearFilters')} onAction={() => onFiltersChange({})} />
              : <EmptyState title={t('api.emptyTitle')} description={t('api.emptyDescription')} />
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border border-border bg-surface">
                <table className="w-full min-w-[720px] text-left text-[13px]">
                  <caption className="sr-only">{t('api.list.title')}</caption>
                  <thead className="border-b border-border bg-background text-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-4 py-2 font-medium">{t('requests.columns.time')}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{t('api.columns.method')}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{t('api.columns.route')}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{t('requests.columns.status')}</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">{t('requests.columns.duration')}</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">{t('api.columns.size')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id} className="border-b border-border last:border-0">
                        <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">{formatDateTime(item.occurredAt, locale)}</td>
                        <td className="px-3 py-2 font-mono text-xs">{item.method}</td>
                        <td className="max-w-[420px] px-3 py-2">
                          <span className="block truncate font-mono text-xs" title={item.path}>{item.route}</span>
                          {item.streaming ? <span className="text-xs text-muted-foreground">{t('api.streaming')}</span> : null}
                        </td>
                        <td className={cn('px-3 py-2 tabular-nums', statusTone(item.status))}>{item.status}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatNumber(item.durationMs, locale)} ms</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{formatBytes(item.responseBytes, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {nextCursor ? (
                <div className="mt-3">
                  <Button type="button" variant="secondary" size="compact" onClick={() => void loadMore()} disabled={loadingMore}>
                    {loadingMore ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : null}
                    {t('requests.loadMore')}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

export { ApiRequestLogs };
export type { ApiRequestLogFilters };
