import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { BarChart3, ScrollText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GatewayRequestLogStatusClass } from '@worklite/contracts';
import { PageHeading } from '@/components/page-heading';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useModelProvidersQuery } from '@/api/queries';
import { GatewayRequestLogs, type RequestLogFilters } from '@/features/logs/request-logs';
import { GatewayStatistics } from '@/features/logs/gateway-statistics';
import { TimeRangeControl, isRangePreset, resolveTimeRange, type LogsTimeRange, type RangePreset } from '@/features/logs/time-range';

const LOGS_TABS = ['statistics', 'requests'] as const;
type LogsTab = (typeof LOGS_TABS)[number];

const REQUEST_LOG_STATUS_CLASSES = ['success', 'client_error', 'server_error'] as const;

type LogsSearch = {
  tab: LogsTab;
  range?: RangePreset;
  from?: string;
  to?: string;
  provider?: string;
  model?: string;
  statusClass?: GatewayRequestLogStatusClass;
  workflowRunId?: string;
};

function isLogsTab(value: unknown): value is LogsTab {
  return typeof value === 'string' && LOGS_TABS.includes(value as LogsTab);
}

function optionalSearchText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalInstant(value: unknown): string | undefined {
  const text = optionalSearchText(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export const Route = createFileRoute('/logs')({
  validateSearch: (search: Record<string, unknown>): LogsSearch => {
    const from = optionalInstant(search.from);
    const to = optionalInstant(search.to);
    // A custom range needs both instants in order, so a half-specified or
    // inverted pair resolves to the default preset instead of an undefined range.
    const custom = from && to && from <= to ? { from, to } : {};
    return {
      tab: isLogsTab(search.tab) ? search.tab : 'statistics',
      range: isRangePreset(search.range) ? search.range : 'from' in custom ? undefined : '24h',
      ...custom,
      provider: optionalSearchText(search.provider),
      model: optionalSearchText(search.model),
      statusClass: REQUEST_LOG_STATUS_CLASSES.includes(search.statusClass as GatewayRequestLogStatusClass) ? search.statusClass as GatewayRequestLogStatusClass : undefined,
      workflowRunId: optionalSearchText(search.workflowRunId),
    };
  },
  component: LogsPage,
});

function LogsPage() {
  const { t } = useTranslation(['logs', 'workspace']);
  const navigate = useNavigate();
  const search = Route.useSearch();
  const { data: providers = [] } = useModelProvidersQuery();

  const range: LogsTimeRange = search.range
    ? { kind: 'preset', preset: search.range }
    : search.from && search.to
      ? { kind: 'custom', from: search.from, to: search.to }
      : { kind: 'preset', preset: '24h' };
  const resolved = resolveTimeRange(range);

  function changeTab(value: string) {
    if (!isLogsTab(value)) return;
    void navigate({ to: '/logs', search: { ...search, tab: value } });
  }

  function changeRange(next: LogsTimeRange) {
    void navigate({
      to: '/logs',
      search: next.kind === 'preset'
        ? { ...search, range: next.preset, from: undefined, to: undefined }
        : { ...search, range: undefined, from: next.from, to: next.to },
    });
  }

  function changeFilters(next: RequestLogFilters) {
    void navigate({
      to: '/logs',
      search: {
        ...search,
        provider: next.provider,
        model: next.model,
        statusClass: next.statusClass,
        workflowRunId: next.workflowRunId,
      },
    });
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
      <WorkspaceChrome crumbs={[{ label: t('workspace:nav.logs') }]} />
      <PageHeading title={t('logs:title')} />
      <div className="mt-6">
        <TimeRangeControl range={range} onRangeChange={changeRange} />
      </div>
      <Tabs value={search.tab} onValueChange={changeTab} className="mt-4">
        <TabsList>
          <TabsTrigger value="statistics"><BarChart3 className="size-4" aria-hidden="true" />{t('logs:views.statistics')}</TabsTrigger>
          <TabsTrigger value="requests"><ScrollText className="size-4" aria-hidden="true" />{t('logs:views.requests')}</TabsTrigger>
        </TabsList>
        <TabsContent value="statistics">
          <GatewayStatistics from={resolved.from} to={resolved.to} />
        </TabsContent>
        <TabsContent value="requests">
          <GatewayRequestLogs
            from={resolved.from}
            to={resolved.to}
            providers={providers}
            filters={{ provider: search.provider, model: search.model, statusClass: search.statusClass, workflowRunId: search.workflowRunId }}
            onFiltersChange={changeFilters}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
