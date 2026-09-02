import { createFileRoute } from '@tanstack/react-router';
import { AlertCircle, ChevronDown, CircleHelp, Clipboard, Info, LoaderCircle, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDiagnosticLogsQuery, useModelProvidersQuery } from '@/api/queries';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { EmptyState } from '@/components/empty-state';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatDateTime } from '@/i18n/format';
import { useLocale } from '@/components/locale-provider';

export const Route = createFileRoute('/settings/logs')({ component: DiagnosticLogsPage });

function levelIcon(level: string) {
  if (level === 'error') return <XCircle className="size-4 text-danger" aria-hidden="true" />;
  if (level === 'warn') return <AlertCircle className="size-4 text-warning" aria-hidden="true" />;
  if (level === 'debug') return <CircleHelp className="size-4 text-muted-foreground" aria-hidden="true" />;
  return <Info className="size-4 text-info" aria-hidden="true" />;
}

function DiagnosticLogsPage() {
  const { t } = useTranslation(['settings', 'common']);
  const { locale } = useLocale();
  const workspaceSlug = 'personal';
  const initialTrace = new URLSearchParams(window.location.search).get('traceId') ?? '';
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState('all');
  const [stage, setStage] = useState('all');
  const [traceId, setTraceId] = useState(initialTrace);
  const [expandedTrace, setExpandedTrace] = useState<string | null>(initialTrace || null);
  const [copied, setCopied] = useState(false);
  const { data: events = [], isLoading, isError, refetch } = useDiagnosticLogsQuery(workspaceSlug, traceId || undefined);
  const { data: modelProviders = [] } = useModelProvidersQuery(workspaceSlug);
  const providerNames = useMemo(() => new Map(modelProviders.map((provider) => [provider.id, provider.name])), [modelProviders]);
  const providers = useMemo(() => [...new Set(events.map((event) => event.providerId).filter((value): value is string => Boolean(value)))], [events]);
  const items = useMemo(() => {
    const query = search.trim().toLowerCase();
    return events.filter((event) => {
      const matchesSearch = !query || `${event.traceId} ${event.providerId ?? ''} ${providerNames.get(event.providerId ?? '') ?? ''} ${event.stage} ${event.message} ${event.operation}`.toLowerCase().includes(query);
      return matchesSearch && (level === 'all' || event.level === level) && (stage === 'all' || event.stage === stage);
    });
  }, [events, level, providerNames, search, stage]);
  const stages = useMemo(() => [...new Set(events.map((event) => event.stage))].sort(), [events]);
  const expandedEvents = expandedTrace ? events.filter((event) => event.traceId === expandedTrace) : [];

  async function copyTrace(value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  function clearTrace() {
    setTraceId('');
    setExpandedTrace(null);
    window.history.replaceState(null, '', '/settings/logs');
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
      <WorkspaceChrome crumbs={[{ label: t('nav.title') }, { label: t('nav.logs') }]} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-2xl font-semibold tracking-tight">{t('logs.title')}</h1><p className="mt-2 text-[13px] text-muted-foreground">{t('logs.description')}</p></div>
        {traceId ? <Button type="button" variant="secondary" size="compact" onClick={clearTrace}>{t('logs.clearTrace')}</Button> : null}
      </div>
      {traceId ? <p className="mt-4 font-mono text-xs text-muted-foreground">{t('logs.traceFilter', { id: traceId })}</p> : null}
      <CollectionToolbar className="mt-6" search={search} onSearchChange={setSearch} placeholder={t('logs.search')} filters={<div className="flex flex-wrap gap-2"><Select value={level} onValueChange={setLevel}><SelectTrigger className="w-32" aria-label={t('logs.columns.level')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All levels</SelectItem><SelectItem value="debug">Debug</SelectItem><SelectItem value="info">Info</SelectItem><SelectItem value="warn">Warn</SelectItem><SelectItem value="error">Error</SelectItem></SelectContent></Select><Select value={stage} onValueChange={setStage}><SelectTrigger className="w-44" aria-label={t('logs.columns.stage')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All stages</SelectItem>{stages.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select></div>} />
      {providers.length > 0 ? <p className="mt-3 text-xs text-muted-foreground">{providers.length} Provider{providers.length === 1 ? '' : 's'} in result</p> : null}
      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-surface">
        <div className="hidden grid-cols-[1.4fr_0.7fr_1fr_1fr_0.8fr_0.8fr_2fr] gap-3 border-b border-border bg-background px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
          <span>{t('logs.columns.time')}</span><span>{t('logs.columns.level')}</span><span>{t('logs.columns.trace')}</span><span>{t('logs.columns.provider')}</span><span>{t('logs.columns.stage')}</span><span>{t('logs.columns.status')}</span><span>{t('logs.columns.message')}</span>
        </div>
        {isLoading ? <div className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground"><LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />{t('logs.loading')}</div> : isError ? <div className="flex flex-wrap items-center gap-3 px-4 py-8 text-sm text-danger"><span role="alert">{t('logs.error')}</span><Button type="button" variant="secondary" size="compact" onClick={() => void refetch()}>{t('logs.retry')}</Button></div> : items.length === 0 ? <div className="p-4"><EmptyState title={events.length === 0 ? t('logs.emptyTitle') : t('logs.noMatchesTitle')} description={events.length === 0 ? t('logs.emptyDescription') : t('logs.noMatchesDescription')} actionLabel={search || level !== 'all' || stage !== 'all' ? t('common:actions.clearFilters') : undefined} onAction={search || level !== 'all' || stage !== 'all' ? () => { setSearch(''); setLevel('all'); setStage('all'); } : undefined} /></div> : items.map((event) => {
          const open = expandedTrace === event.traceId;
          return <div key={event.id} className="border-b border-border last:border-b-0"><button type="button" className="grid w-full grid-cols-1 gap-2 px-4 py-3 text-left hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45 md:grid-cols-[1.4fr_0.7fr_1fr_1fr_0.8fr_0.8fr_2fr] md:items-center md:gap-3 md:py-[10px]" onClick={() => setExpandedTrace(open ? null : event.traceId)} aria-expanded={open}><span className="tabular-nums text-[13px]">{formatDateTime(event.timestamp, locale)}</span><span className="flex items-center gap-1.5 text-[13px]"><span className="sr-only">{event.level}</span>{levelIcon(event.level)}<span className="capitalize">{event.level}</span></span><span className="flex items-center gap-1 font-mono text-xs"><span className="truncate">{event.traceId}</span><ChevronDown className={`size-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" /></span><span className="truncate text-[13px]">{event.providerId ? providerNames.get(event.providerId) ?? event.providerId : '-'}</span><span className="font-mono text-xs">{event.stage}</span><span className="text-[13px]">{event.status}</span><span className="truncate text-[13px] text-muted-foreground">{event.message}</span></button>{open ? <div className="border-t border-border bg-surface-subtle px-4 py-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">{t('logs.details')}</h2><Button type="button" variant="ghost" size="compact" onClick={() => void copyTrace(event.traceId)}><Clipboard className="size-4" />{copied ? t('logs.copied') : t('logs.copyTrace')}</Button></div><div className="mt-3 space-y-3">{expandedEvents.map((detail) => <div key={detail.id} className="rounded-md border border-border bg-surface p-3"><div className="flex flex-wrap items-center gap-2 text-xs"><span className="flex items-center gap-1">{levelIcon(detail.level)}{detail.level}</span><span className="font-mono">{detail.stage}</span><span>{detail.status}</span>{detail.durationMs !== null ? <span className="tabular-nums text-muted-foreground">{t('logs.duration', { ms: detail.durationMs })}</span> : null}</div><p className="mt-2 break-words text-[13px]">{detail.message}</p><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-2 font-mono text-xs text-muted-foreground">{JSON.stringify(detail.metadata, null, 2)}</pre></div>)}</div></div> : null}</div>;
        })}
      </div>
    </div>
  );
}
