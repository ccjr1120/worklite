import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PortkeyGatewayStats } from '@worklite/contracts';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useLocale } from '@/components/locale-provider';
import { formatNumber } from '@/i18n/format';
import { usePortkeyGatewayStatsQuery } from '@/api/queries';
import type { AppLocale } from '@/i18n/locale';

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-border bg-surface p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-lg font-semibold tabular-nums">{value}</p></div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-1 break-words font-mono text-xs">{value}</p></div>;
}

function BreakdownRow({ row, open, onToggle, locale, metricValue }: { row: PortkeyGatewayStats['breakdown'][number]; open: boolean; onToggle: () => void; locale: AppLocale; metricValue: (value: number | null, suffix?: string) => string }) {
  const { t } = useTranslation('logs');
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
        <div className="grid gap-4 border-t border-border bg-surface-subtle px-4 py-4 text-[13px] sm:grid-cols-3">
          <Detail label={t('statistics.endpoints')} value={row.endpoints.map((item) => `${item.endpoint} (${item.requests})`).join(', ') || t('statistics.unavailable')} />
          <Detail label={t('statistics.statuses')} value={row.statuses.map((item) => `${item.status} (${item.requests})`).join(', ') || t('statistics.unavailable')} />
          <Detail label={t('statistics.tokens')} value={`${t('statistics.input')}: ${metricValue(row.promptTokens)} · ${t('statistics.output')}: ${metricValue(row.completionTokens)} · ${t('statistics.total')}: ${metricValue(row.totalTokens)}`} />
        </div>
      ) : null}
    </div>
  );
}

function GatewayStatistics({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation('logs');
  const { locale } = useLocale();
  const [expanded, setExpanded] = useState<string | null>(null);
  const statsQuery = usePortkeyGatewayStatsQuery({ from, to });
  const stats = statsQuery.data;
  const summary = stats?.summary;
  const metricValue = (value: number | null, suffix = '') => value === null ? t('statistics.unavailable') : `${formatNumber(value, locale)}${suffix}`;

  // A row key from one period does not identify a row in another, so a range
  // change closes whatever was open instead of leaving a stale key expanded.
  useEffect(() => {
    setExpanded(null);
  }, [from, to]);

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
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label={t('statistics.requests')} value={formatNumber(summary?.requests ?? 0, locale)} />
        <Metric label={t('statistics.successRate')} value={summary?.successRate === null || summary?.successRate === undefined ? t('statistics.unavailable') : `${summary.successRate}%`} />
        <Metric label={t('statistics.averageLatency')} value={metricValue(summary?.averageLatencyMs ?? null, ' ms')} />
        <Metric label={t('statistics.totalTokens')} value={metricValue(summary?.totalTokens ?? null)} />
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="hidden grid-cols-[1.2fr_1.4fr_0.7fr_0.8fr_0.9fr] gap-3 border-b border-border bg-background px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
          <span>{t('statistics.provider')}</span>
          <span>{t('statistics.model')}</span>
          <span>{t('statistics.requests')}</span>
          <span>{t('statistics.successRate')}</span>
          <span>{t('statistics.averageLatency')}</span>
        </div>
        {stats.breakdown.map((row) => {
          const key = `${row.provider}\u0000${row.model}`;
          return <BreakdownRow key={key} row={row} open={expanded === key} onToggle={() => setExpanded(expanded === key ? null : key)} locale={locale} metricValue={metricValue} />;
        })}
      </div>
    </div>
  );
}

export { GatewayStatistics };
