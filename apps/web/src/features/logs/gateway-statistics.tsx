import { ChevronDown, ScrollText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PortkeyGatewayStats } from '@worklite/contracts';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useLocale } from '@/components/locale-provider';
import { formatNumber } from '@/i18n/format';
import { usePortkeyGatewayStatsQuery } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AppLocale } from '@/i18n/locale';

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-border bg-surface p-3 shadow-xs"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-lg font-semibold tabular-nums">{value}</p></div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-1 break-words font-mono text-xs">{value}</p></div>;
}

function BreakdownRow({ row, open, onToggle, onViewRequests, locale, metricValue }: { row: PortkeyGatewayStats['breakdown'][number]; open: boolean; onToggle: () => void; onViewRequests: () => void; locale: AppLocale; metricValue: (value: number | null, suffix?: string) => string }) {
  const { t } = useTranslation(['logs', 'common']);
  const rate = row.requests ? Math.round((row.successful / row.requests) * 1000) / 10 : null;
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full grid-cols-1 gap-2 px-4 py-3 text-left hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45 md:grid-cols-[1.2fr_1.4fr_0.7fr_0.8fr_0.9fr] md:items-center md:gap-3"
      >
        <span className="font-medium">{row.provider}</span>
        <span className="break-all font-mono text-xs text-muted-foreground">{row.model}</span>
        <span className="text-[13px] tabular-nums">{formatNumber(row.requests, locale)}</span>
        <span className="text-[13px] tabular-nums">{rate === null ? t('statistics.unavailable') : `${rate}%`}</span>
        <span className="text-[13px] tabular-nums text-muted-foreground">
          {metricValue(row.averageLatencyMs, ' ms')}
          <ChevronDown className={`ml-1 inline size-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </span>
      </button>
      {open ? (
        <div className="grid gap-4 border-t border-border bg-surface-subtle px-4 py-4 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
          <Detail label={t('statistics.endpoints')} value={row.endpoints.map((item) => `${item.endpoint} (${item.requests})`).join(', ') || t('statistics.unavailable')} />
          <Detail label={t('statistics.statuses')} value={row.statuses.map((item) => `${item.status} (${item.requests})`).join(', ') || t('statistics.unavailable')} />
          <Detail label={t('statistics.tokens')} value={`${t('statistics.input')}: ${metricValue(row.promptTokens)} · ${t('statistics.output')}: ${metricValue(row.completionTokens)} · ${t('statistics.total')}: ${metricValue(row.totalTokens)}`} />
          <Button type="button" variant="secondary" size="compact" className="w-fit" aria-label={t('statistics.viewRequestsForModel', { provider: row.provider, model: row.model })} onClick={onViewRequests}><ScrollText className="size-4" aria-hidden="true" />{t('statistics.viewRequests')}</Button>
        </div>
      ) : null}
    </div>
  );
}

function GatewayStatistics({ from, to, filters = {}, onFiltersChange, onViewRequests }: { from: string; to: string; filters?: { provider?: string; model?: string }; onFiltersChange?: (next: { provider?: string; model?: string }) => void; onViewRequests?: (provider: string, model: string) => void }) {
  const { t } = useTranslation(['logs', 'common']);
  const { locale } = useLocale();
  const [expanded, setExpanded] = useState<string | null>(null);
  const statsQuery = usePortkeyGatewayStatsQuery({ from, to });
  const stats = statsQuery.data;
  const summary = stats?.summary;
  const metricValue = (value: number | null, suffix = '') => value === null ? t('statistics.unavailable') : `${formatNumber(value, locale)}${suffix}`;
  const providers = [...new Set((stats?.breakdown ?? []).map((row) => row.provider))].sort();
  const filteredBreakdown = (stats?.breakdown ?? []).filter((row) => (!filters.provider || row.provider === filters.provider) && (!filters.model || row.model === filters.model));
  const sumKnown = (values: Array<number | null>) => values.some((value) => value !== null) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : null;
  const successful = filteredBreakdown.reduce((total, row) => total + row.successful, 0);
  const requests = filteredBreakdown.reduce((total, row) => total + row.requests, 0);
  const scopedSummary = filters.provider || filters.model
    ? {
        requests,
        successRate: requests ? Math.round((successful / requests) * 1_000) / 10 : null,
        averageLatencyMs: requests ? Math.round(filteredBreakdown.reduce((total, row) => total + (row.averageLatencyMs ?? 0) * row.requests, 0) / requests) : null,
        totalTokens: sumKnown(filteredBreakdown.map((row) => row.totalTokens)),
      }
    : summary;

  // A row key from one period does not identify a row in another, so a range
  // change closes whatever was open instead of leaving a stale key expanded.
  useEffect(() => {
    setExpanded(null);
  }, [from, to, filters.provider, filters.model]);

  if (statsQuery.isLoading) {
    return (
      <div className="space-y-3" role="status" aria-busy="true" aria-live="polite">
        <span className="sr-only">{t('statistics.loading')}</span>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-[70px]" />)}</div>
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (statsQuery.isError) {
    return <ErrorState title={t('views.statistics')} description={t('statistics.error')} onAction={() => void statsQuery.refetch()} />;
  }

  if (!stats || stats.summary.requests === 0) {
    return <EmptyState title={t('statistics.emptyTitle')} description={t('statistics.emptyDescription')} />;
  }

  return (
    <div className="space-y-5">
      {onFiltersChange ? <div className="flex flex-wrap gap-2">
        <Select value={filters.provider ?? 'all'} onValueChange={(value) => onFiltersChange({ provider: value === 'all' ? undefined : value, model: undefined })}>
          <SelectTrigger className="w-[190px]" aria-label={t('requests.filters.provider')}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">{t('requests.filters.provider')}</SelectItem>{providers.map((provider) => <SelectItem key={provider} value={provider}>{provider}</SelectItem>)}</SelectContent>
        </Select>
        {filters.provider ? <Select value={filters.model ?? 'all'} onValueChange={(value) => onFiltersChange({ ...filters, model: value === 'all' ? undefined : value })}>
          <SelectTrigger className="w-[220px]" aria-label={t('requests.filters.model')}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">{t('requests.filters.model')}</SelectItem>{[...new Set((stats?.breakdown ?? []).filter((row) => row.provider === filters.provider).map((row) => row.model))].sort().map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent>
        </Select> : null}
        {filters.provider || filters.model ? <Button type="button" variant="ghost" size="compact" onClick={() => onFiltersChange({})}>{t('common:actions.clearFilters')}</Button> : null}
      </div> : null}
      {(filters.provider || filters.model) && filteredBreakdown.length === 0 ? onFiltersChange ? (
        <EmptyState title={t('statistics.noMatchesTitle')} description={t('statistics.noMatchesDescription')} actionLabel={t('common:actions.clearFilters')} onAction={() => onFiltersChange({})} />
      ) : <EmptyState title={t('statistics.emptyTitle')} description={t('statistics.emptyDescription')} /> : <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label={t('statistics.requests')} value={formatNumber(scopedSummary?.requests ?? 0, locale)} />
        <Metric label={t('statistics.successRate')} value={scopedSummary?.successRate === null || scopedSummary?.successRate === undefined ? t('statistics.unavailable') : `${scopedSummary.successRate}%`} />
        <Metric label={t('statistics.averageLatency')} value={metricValue(scopedSummary?.averageLatencyMs ?? null, ' ms')} />
        <Metric label={t('statistics.totalTokens')} value={metricValue(scopedSummary?.totalTokens ?? null)} />
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="hidden grid-cols-[1.2fr_1.4fr_0.7fr_0.8fr_0.9fr] gap-3 border-b border-border bg-background px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
          <span>{t('statistics.provider')}</span>
          <span>{t('statistics.model')}</span>
          <span>{t('statistics.requests')}</span>
          <span>{t('statistics.successRate')}</span>
          <span>{t('statistics.averageLatency')}</span>
        </div>
        {filteredBreakdown.map((row) => {
          const key = `${row.provider}\u0000${row.model}`;
          return <BreakdownRow key={key} row={row} open={expanded === key} onToggle={() => setExpanded(expanded === key ? null : key)} onViewRequests={() => onViewRequests?.(row.provider, row.model)} locale={locale} metricValue={metricValue} />;
        })}
      </div>
      </>}
    </div>
  );
}

export { GatewayStatistics };
