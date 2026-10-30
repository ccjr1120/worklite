import { ChevronDown, Clipboard, KeyRound, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GatewayRequestLogList, GatewayRequestLogListItem, GatewayRequestLogStatusClass, GatewaySurface, ModelProviderView } from '@worklite/contracts';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime, formatNumber, formatTokenCount } from '@/i18n/format';
import { useGatewayRequestLogQuery, useGatewayRequestLogsQuery } from '@/api/queries';
import { api } from '@/api/client';
import type { AppLocale } from '@/i18n/locale';

type RequestLogFilters = {
  provider?: string;
  model?: string;
  statusClass?: GatewayRequestLogStatusClass;
  surface?: GatewaySurface;
  conversationId?: string;
  projectTaskId?: string;
  executor?: string;
  executorCategoryId?: string;
  teamRunId?: string;
  workflowId?: string;
  workflowRunId?: string;
  nodeRunId?: string;
};

// The attribution part of a filter, as chips: these are set by following a usage row
// rather than typed, so they are shown and cleared rather than offered as pickers.
const ATTRIBUTION_FILTER_KEYS = ['surface', 'conversationId', 'projectTaskId', 'executor', 'executorCategoryId', 'teamRunId', 'workflowId', 'workflowRunId', 'nodeRunId'] as const;

function capturedBodyText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function requestLogStatusBadge(status: number): 'completed' | 'failed' {
  return status >= 200 && status < 400 ? 'completed' : 'failed';
}

function CapturedBody({ label, body, copyLabel }: { label: string; body: string; copyLabel: string }) {
  const { t } = useTranslation(['logs', 'common']);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Button type="button" variant="ghost" size="compact" onClick={() => void copy()} aria-label={copyLabel}>
          <Clipboard aria-hidden="true" />
          {copied ? t('requests.copied') : t('common:actions.copy' as never)}
        </Button>
      </div>
      {/* A bounded scroll container must be reachable without a pointer, so it takes focus
          while keeping its non-interactive group role. */}
      <div
        role="group"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label={label}
        className="mt-1 max-h-72 overflow-auto rounded-md border border-border bg-surface px-2 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45"
      >
        <pre className="whitespace-pre-wrap break-words font-mono text-xs">{body}</pre>
      </div>
    </div>
  );
}

function RequestLogRow({ item, expanded, onToggle, locale, onOpenProvider }: { item: GatewayRequestLogListItem; expanded: boolean; onToggle: () => void; locale: AppLocale; onOpenProvider?: (provider: string) => void }) {
  const { t } = useTranslation('logs');
  const detailQuery = useGatewayRequestLogQuery(expanded ? item.id : undefined);
  const detail = detailQuery.data;
  const tokenParts = (format: typeof formatNumber) => [
    item.promptTokens !== null ? `${t('statistics.input')}: ${format(item.promptTokens, locale)}` : null,
    item.cacheReadTokens !== null ? `${t('statistics.cacheRead')}: ${format(item.cacheReadTokens, locale)}` : null,
    item.cacheCreationTokens !== null ? `${t('statistics.cacheCreation')}: ${format(item.cacheCreationTokens, locale)}` : null,
    item.completionTokens !== null ? `${t('statistics.output')}: ${format(item.completionTokens, locale)}` : null,
    item.totalTokens !== null ? `${t('statistics.total')}: ${format(item.totalTokens, locale)}` : null,
  ].filter((value): value is string => value !== null);
  const tokenMetrics = tokenParts(formatTokenCount);
  const tokenMetricsExact = tokenParts(formatNumber);

  return (
    <li className="rounded-md border border-border bg-surface-subtle">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={t('requests.rowLabel', { provider: item.provider, model: item.model, time: formatDateTime(item.occurredAt, locale) })}
        className="grid w-full grid-cols-1 gap-2 px-3 py-2 text-left hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45 md:grid-cols-[0.9fr_0.8fr_1fr_1fr_0.5fr_0.5fr] md:items-center md:gap-3"
      >
        <span className="text-[13px] tabular-nums text-muted-foreground">{formatDateTime(item.occurredAt, locale)}</span>
        <span className="truncate font-medium">{item.provider}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{item.model}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{item.endpoint}</span>
        <span className="flex items-center gap-1.5"><StatusBadge status={requestLogStatusBadge(item.status)} /><span className="text-xs tabular-nums text-muted-foreground">{item.status}</span></span>
        <span className="flex items-center justify-end gap-1 text-xs tabular-nums text-muted-foreground">
          {item.durationMs} ms
          <ChevronDown className={`ml-1 inline size-4 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
        </span>
      </button>
      {expanded ? (
        <div className="border-t border-border px-3 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {item.streaming ? <span>{t('requests.streaming')}</span> : null}
            <span className="font-mono">{t(`usage.surfaces.${item.surface}` as never)}</span>
            {item.executor ? <span className="font-mono">{item.executor}</span> : null}
            {item.conversationId ? <span className="font-mono">{t('requests.correlatedConversation', { id: item.conversationId })}</span> : null}
            {item.workflowRunId ? <span className="font-mono">{t('requests.correlatedRun', { id: item.workflowRunId })}</span> : null}
            {item.teamRunId ? <span className="font-mono">{t('requests.correlatedTeamRun', { id: item.teamRunId })}</span> : null}
            {item.nodeRunId ? <span className="font-mono">{t('requests.correlatedNode', { id: item.nodeRunId })}</span> : null}
            {tokenMetrics.length ? <span className="tabular-nums" title={tokenMetricsExact.join(' · ')}>{tokenMetrics.join(' · ')}</span> : null}
            {onOpenProvider ? <Button type="button" variant="ghost" size="compact" className="ml-auto" onClick={() => onOpenProvider(item.provider)}><KeyRound className="size-4" aria-hidden="true" />{t('requests.openProvider')}</Button> : null}
          </div>
          {detailQuery.isLoading ? (
            <div role="status" aria-busy="true" className="mt-2 grid gap-2">
              <Skeleton className="h-24 w-full rounded-md" />
              <Skeleton className="h-24 w-full rounded-md" />
            </div>
          ) : detailQuery.isError || !detail ? (
            <p className="mt-2 text-[13px] text-danger" role="alert">{t('requests.detailError')}</p>
          ) : (
            <div className="mt-2 grid gap-3">
              <CapturedBody label={t('requests.request')} body={capturedBodyText(detail.request)} copyLabel={t('requests.copyRequest')} />
              {detail.response.kind === 'unavailable' ? (
                <p className="text-[13px] text-muted-foreground">{t('requests.responseUnavailable', { reason: detail.response.reason })}</p>
              ) : (
                <CapturedBody
                  label={detail.response.kind === 'stream' ? t('requests.streamEvents') : t('requests.response')}
                  body={detail.response.kind === 'stream' ? capturedBodyText(detail.response.events) : capturedBodyText(detail.response.body)}
                  copyLabel={t('requests.copyResponse')}
                />
              )}
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

function GatewayRequestLogs({ from, to, providers, filters, onFiltersChange, focusedRequestId, onFocusedRequestClear, onOpenProvider, lockProvider = false }: { from: string; to: string; providers: ModelProviderView[]; filters: RequestLogFilters; onFiltersChange: (next: RequestLogFilters) => void; focusedRequestId?: string; onFocusedRequestClear?: () => void; onOpenProvider?: (provider: string) => void; lockProvider?: boolean }) {
  const { t } = useTranslation(['logs', 'common']);
  const { locale } = useLocale();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pages, setPages] = useState<GatewayRequestLogList[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const logsQuery = useGatewayRequestLogsQuery({ ...filters, from, to });
  const focusedQuery = useGatewayRequestLogQuery(focusedRequestId);
  const hasFilters = Boolean(filters.provider || filters.model || filters.statusClass || ATTRIBUTION_FILTER_KEYS.some((key) => filters[key]));
  const availableModels = filters.provider
    ? providers.find((provider) => provider.name === filters.provider)?.models ?? []
    : [...new Set(providers.flatMap((provider) => provider.models))].sort();

  // Accumulated pages describe the previous query, so a new range or filter
  // discards them rather than appending results from a different question.
  useEffect(() => {
    setPages([]);
    setExpandedId(null);
  }, [from, to, filters.provider, filters.model, filters.statusClass, filters.surface, filters.conversationId, filters.projectTaskId, filters.executor, filters.executorCategoryId, filters.teamRunId, filters.workflowId, filters.workflowRunId, filters.nodeRunId]);

  useEffect(() => {
    setExpandedId(focusedRequestId ?? null);
  }, [focusedRequestId]);

  const items = useMemo(() => focusedRequestId
    ? focusedQuery.data ? [focusedQuery.data] : []
    : [...(logsQuery.data?.items ?? []), ...pages.flatMap((page) => page.items)], [focusedRequestId, focusedQuery.data, logsQuery.data, pages]);
  const nextCursor = pages.at(-1)?.nextCursor ?? logsQuery.data?.nextCursor ?? null;
  const retainedFrom = logsQuery.data?.retainedFrom;
  // Statistics answer the whole range; details only reach back 12 hours. Saying
  // so is the difference between "already expired" and "nothing happened".
  const truncated = Boolean(retainedFrom && from < retainedFrom);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.gatewayRequestLogs({ ...filters, from, to, cursor: nextCursor });
      setPages((current) => [...current, page]);
    } catch {
      // The Load more control stays available so the reader can retry.
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section aria-labelledby="gateway-request-logs-title">
      <div>
        <h2 id="gateway-request-logs-title" className="text-base font-semibold">{t('requests.title')}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">{t('requests.retention')}</p>
        {truncated && retainedFrom ? (
          <p className="mt-1 text-[13px] text-muted-foreground">{t('requests.retentionTruncated', { retainedFrom: formatDateTime(retainedFrom, locale) })}</p>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!lockProvider ? <Select value={filters.provider ?? 'all'} onValueChange={(value) => onFiltersChange({ ...filters, provider: value === 'all' ? undefined : value, model: undefined })}>
          <SelectTrigger className="w-[190px]" aria-label={t('requests.filters.provider')}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('requests.filters.provider')}</SelectItem>
            {providers.map((provider) => <SelectItem key={provider.id} value={provider.name}>{provider.name}</SelectItem>)}
          </SelectContent>
        </Select> : null}
        <Select value={filters.model ?? 'all'} onValueChange={(value) => onFiltersChange({ ...filters, model: value === 'all' ? undefined : value })}>
          <SelectTrigger className="w-[220px]" aria-label={t('requests.filters.model')}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">{t('requests.filters.model')}</SelectItem>{availableModels.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={filters.statusClass ?? 'all'} onValueChange={(value) => onFiltersChange({ ...filters, statusClass: value === 'all' ? undefined : value as GatewayRequestLogStatusClass })}>
          <SelectTrigger className="w-[190px]" aria-label={t('requests.filters.statusClass')}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('requests.statusClass.all')}</SelectItem>
            <SelectItem value="success">{t('requests.statusClass.success')}</SelectItem>
            <SelectItem value="client_error">{t('requests.statusClass.clientError')}</SelectItem>
            <SelectItem value="server_error">{t('requests.statusClass.serverError')}</SelectItem>
          </SelectContent>
        </Select>
        {ATTRIBUTION_FILTER_KEYS.flatMap((key) => {
          const value = filters[key];
          return value ? [(
            <span key={key} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-subtle px-2 py-1 font-mono text-xs">
              {`${t(`requests.filters.${key}` as never)}: ${key === 'surface' ? t(`usage.surfaces.${value}` as never) : value}`}
            </span>
          )] : [];
        })}
        {hasFilters ? (
          <Button type="button" variant="ghost" size="compact" onClick={() => onFiltersChange({})}>{t('common:actions.clearFilters')}</Button>
        ) : null}
        {focusedRequestId && onFocusedRequestClear ? <Button type="button" variant="ghost" size="compact" onClick={onFocusedRequestClear}>{t('requests.showAll')}</Button> : null}
      </div>

      <div className="mt-4">
        {focusedRequestId && focusedQuery.isError ? (
          <ErrorState title={t('requests.title')} description={t('requests.detailError')} onAction={() => void focusedQuery.refetch()} />
        ) : focusedRequestId && focusedQuery.isLoading || (!focusedRequestId && logsQuery.isLoading) ? (
          <div role="status" aria-busy="true" aria-live="polite" className="grid gap-2">
            <span className="sr-only">{t('requests.title')}</span>
            {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-12 w-full rounded-md" />)}
          </div>
        ) : !focusedRequestId && logsQuery.isError ? (
          <ErrorState title={t('requests.title')} description={t('requests.error')} onAction={() => void logsQuery.refetch()} />
        ) : items.length === 0 ? (
          hasFilters
            ? <EmptyState title={t('requests.noMatches.title')} description={t('requests.noMatches.description')} actionLabel={t('common:actions.clearFilters')} onAction={() => onFiltersChange({})} />
            : <EmptyState title={t('requests.emptyTitle')} description={t('requests.emptyDescription')} />
        ) : (
          <>
            <ul className="grid gap-2">
              {items.map((item) => (
                <RequestLogRow
                  key={item.id}
                  item={item}
                  expanded={expandedId === item.id}
                  onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
                  locale={locale}
                  onOpenProvider={onOpenProvider}
                />
              ))}
            </ul>
            {!focusedRequestId && nextCursor ? (
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
  );
}

export { GatewayRequestLogs };
export type { RequestLogFilters };
