import { ChevronDown, ScrollText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GATEWAY_STATS_GROUP_BYS, type GatewayAttributionGroup, type GatewayStatsGroupBy, type GatewaySurface } from '@worklite/contracts';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useLocale } from '@/components/locale-provider';
import { formatNumber, formatTokenCount } from '@/i18n/format';
import { usePortkeyGatewayStatsQuery } from '@/api/queries';
import type { AppLocale } from '@/i18n/locale';
import type { RequestLogFilters } from './request-logs';

/**
 * The identity of a group, as text a reader can act on. Grouping by surface shows the
 * surface alone; the finer dimensions show the surface plus the id they group on, so a
 * conversation row stays distinguishable from that conversation's project tasks.
 */
function groupLabel(group: GatewayAttributionGroup, groupBy: GatewayStatsGroupBy, surfaceLabel: (surface: GatewaySurface | null) => string): { title: string; detail: string | null } {
  if (groupBy === 'conversation') return { title: surfaceLabel(group.surface), detail: group.conversationId };
  if (groupBy === 'executor') return { title: surfaceLabel(group.surface), detail: group.executor };
  if (groupBy === 'coder') return { title: group.coderId ?? '', detail: group.teamRunId };
  if (groupBy === 'workflow') return { title: group.workflowId ?? '', detail: group.workflowRunId };
  if (groupBy === 'team_run') return { title: group.teamRunId ?? '', detail: null };
  if (groupBy === 'node_run') return { title: group.teamRunId ?? group.workflowRunId ?? '', detail: group.nodeRunId };
  return { title: surfaceLabel(group.surface), detail: null };
}

/** The request-log filter that narrows the list to exactly this group. */
function groupRequestFilters(group: GatewayAttributionGroup, groupBy: GatewayStatsGroupBy): RequestLogFilters {
  if (groupBy === 'conversation') return { surface: group.surface ?? undefined, conversationId: group.conversationId ?? undefined };
  if (groupBy === 'executor') return { surface: group.surface ?? undefined, executor: group.executor ?? undefined };
  if (groupBy === 'coder') return { coderId: group.coderId ?? undefined, teamRunId: group.teamRunId ?? undefined };
  if (groupBy === 'workflow') return { workflowId: group.workflowId ?? undefined, workflowRunId: group.workflowRunId ?? undefined };
  if (groupBy === 'team_run') return { teamRunId: group.teamRunId ?? undefined };
  if (groupBy === 'node_run') return { teamRunId: group.teamRunId ?? undefined, workflowRunId: group.workflowRunId ?? undefined, nodeRunId: group.nodeRunId ?? undefined };
  return { surface: group.surface ?? undefined };
}

function UsageRow({ group, groupBy, open, onToggle, onViewRequests, locale, metricValue, tokenValue, tokenExact, surfaceLabel }: {
  group: GatewayAttributionGroup;
  groupBy: GatewayStatsGroupBy;
  open: boolean;
  onToggle: () => void;
  onViewRequests: () => void;
  locale: AppLocale;
  metricValue: (value: number | null, suffix?: string) => string;
  tokenValue: (value: number | null) => string;
  tokenExact: (value: number | null) => string;
  surfaceLabel: (surface: GatewaySurface | null) => string;
}) {
  const { t } = useTranslation(['logs', 'common']);
  const { title, detail } = groupLabel(group, groupBy, surfaceLabel);
  const rate = group.requests ? Math.round((group.successful / group.requests) * 1000) / 10 : null;
  const tokenLine = (format: (value: number | null) => string) => `${t('statistics.input')}: ${format(group.promptTokens)} · ${t('statistics.cacheRead')}: ${format(group.cacheReadTokens)} · ${t('statistics.cacheCreation')}: ${format(group.cacheCreationTokens)} · ${t('statistics.output')}: ${format(group.completionTokens)}`;
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full grid-cols-1 gap-2 px-4 py-3 text-left hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45 md:grid-cols-[1.1fr_1.5fr_0.7fr_0.9fr_0.8fr] md:items-center md:gap-3"
      >
        <span className="font-medium">{title}</span>
        <span className="break-all font-mono text-xs text-muted-foreground">{detail ?? t('usage.noDetail')}</span>
        <span className="text-[13px] tabular-nums">{formatNumber(group.requests, locale)}</span>
        <span className="text-[13px] tabular-nums" title={tokenExact(group.totalTokens)}>{tokenValue(group.totalTokens)}</span>
        <span className="text-[13px] tabular-nums text-muted-foreground">
          {rate === null ? t('statistics.unavailable') : `${rate}%`}
          <ChevronDown className={`ml-1 inline size-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </span>
      </button>
      {open ? (
        <div className="grid gap-4 border-t border-border bg-surface-subtle px-4 py-4 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('statistics.tokens')}</p>
            <p className="mt-1 break-words font-mono text-xs" title={tokenLine(tokenExact)}>
              {tokenLine(tokenValue)}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('usage.requestCounts')}</p>
            <p className="mt-1 break-words font-mono text-xs">
              {`${t('usage.failed')}: ${formatNumber(group.failed, locale)} · ${t('usage.withUsage')}: ${formatNumber(group.usageRequests, locale)} · ${t('statistics.averageLatency')}: ${metricValue(group.averageLatencyMs, ' ms')}`}
            </p>
          </div>
          <Button type="button" variant="secondary" size="compact" className="w-fit" onClick={onViewRequests}>
            <ScrollText className="size-4" aria-hidden="true" />
            {t('statistics.viewRequests')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function GatewayUsage({ from, to, groupBy, onGroupByChange, onViewRequests }: {
  from: string;
  to: string;
  groupBy: GatewayStatsGroupBy;
  onGroupByChange: (next: GatewayStatsGroupBy) => void;
  onViewRequests: (filters: RequestLogFilters) => void;
}) {
  const { t } = useTranslation(['logs', 'common']);
  const { locale } = useLocale();
  const [expanded, setExpanded] = useState<string | null>(null);
  const statsQuery = usePortkeyGatewayStatsQuery({ from, to, groupBy });
  const groups = statsQuery.data?.attribution.groups ?? [];
  const metricValue = (value: number | null, suffix = '') => value === null ? t('statistics.unavailable') : `${formatNumber(value, locale)}${suffix}`;
  const tokenValue = (value: number | null) => value === null ? t('statistics.unavailable') : formatTokenCount(value, locale);
  const tokenExact = tokenValue;
  const surfaceLabel = (surface: GatewaySurface | null) => surface ? t(`usage.surfaces.${surface}` as never) : t('usage.surfaces.unattributed');

  // A group key identifies a row within one period and grouping only, so changing
  // either closes whatever was open rather than leaving a stale key expanded.
  useEffect(() => {
    setExpanded(null);
  }, [from, to, groupBy]);

  if (statsQuery.isLoading) {
    return (
      <div className="space-y-3" role="status" aria-busy="true" aria-live="polite">
        <span className="sr-only">{t('statistics.loading')}</span>
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (statsQuery.isError) {
    return <ErrorState title={t('views.usage')} description={t('statistics.error')} onAction={() => void statsQuery.refetch()} />;
  }

  return (
    <section aria-labelledby="gateway-usage-title" className="space-y-4">
      <div>
        <h2 id="gateway-usage-title" className="text-base font-semibold">{t('usage.title')}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">{t('usage.description')}</p>
        <p className="mt-1 text-[13px] text-muted-foreground">{t('usage.executorCaveat')}</p>
      </div>
      <Select value={groupBy} onValueChange={(value) => onGroupByChange(value as GatewayStatsGroupBy)}>
        <SelectTrigger className="w-[220px]" aria-label={t('usage.groupBy')}><SelectValue /></SelectTrigger>
        <SelectContent>
          {GATEWAY_STATS_GROUP_BYS.filter((option) => !['coder', 'workflow', 'team_run', 'node_run'].includes(option)).map((option) => <SelectItem key={option} value={option}>{t(`usage.groupBys.${option}` as never)}</SelectItem>)}
        </SelectContent>
      </Select>
      {groups.length === 0 ? (
        <EmptyState title={t('usage.emptyTitle')} description={t('usage.emptyDescription')} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <div className="hidden grid-cols-[1.1fr_1.5fr_0.7fr_0.9fr_0.8fr] gap-3 border-b border-border bg-background px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
            <span>{t('usage.columns.group')}</span>
            <span>{t(`usage.columns.detail.${groupBy}` as never)}</span>
            <span>{t('statistics.requests')}</span>
            <span>{t('statistics.totalTokens')}</span>
            <span>{t('statistics.successRate')}</span>
          </div>
          {groups.map((group) => (
            <UsageRow
              key={group.key}
              group={group}
              groupBy={groupBy}
              open={expanded === group.key}
              onToggle={() => setExpanded(expanded === group.key ? null : group.key)}
              onViewRequests={() => onViewRequests(groupRequestFilters(group, groupBy))}
              locale={locale}
              metricValue={metricValue}
              tokenValue={tokenValue}
              tokenExact={tokenExact}
              surfaceLabel={surfaceLabel}
            />
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('statistics.tokenDefinition')}</p>
    </section>
  );
}

export { GatewayUsage };
