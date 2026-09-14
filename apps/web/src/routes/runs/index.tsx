import { createFileRoute, Link } from '@tanstack/react-router';
import { ChevronDown, FileStack, LoaderCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArtifactView, RunView } from '@worklite/contracts';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { EmptyState } from '@/components/empty-state';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { durationParts, formatDateTime } from '@/i18n/format';
import { useRunQuery, useRunsQuery } from '@/api/queries';
import { cn } from '@/lib/utils';

type RunFilterStatus = 'queued' | 'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled';

function toUiStatus(status: string): RunFilterStatus {
  if (status === 'succeeded') return 'completed';
  if (status === 'timed_out') return 'failed';
  return status as RunFilterStatus;
}

export const Route = createFileRoute('/runs/')({
  component: RunListPage,
});

function RunListPage() {
  const { t } = useTranslation(['runs', 'common']);
  const { locale } = useLocale();
  const workspaceSlug = 'personal';
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<RunFilterStatus | 'all'>('all');
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const { data: all = [], isLoading, isError } = useRunsQuery(workspaceSlug);
  const items = useMemo(
    () =>
      all.filter((item) => {
        const matchesSearch = `${item.workflowName} ${item.initiator} ${item.id}`.toLowerCase().includes(search.toLowerCase());
        const matchesStatus = status === 'all' || toUiStatus(item.status) === status;
        return matchesSearch && matchesStatus;
      }),
    [all, search, status],
  );

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
      <WorkspaceChrome crumbs={[{ label: t('title') }]} />
      <PageHeading title={t('title')} description={t('description')} />
      <CollectionToolbar
        className="mt-6"
        search={search}
        onSearchChange={setSearch}
        placeholder={t('search')}
        filters={
          <div className="flex flex-wrap gap-1">
            {(['all', 'queued', 'running', 'waiting_for_input', 'completed', 'failed', 'cancelled'] as const).map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={status === value ? 'secondary' : 'ghost'}
                className={cn(status === value && 'border-brand/40')}
                onClick={() => setStatus(value)}
              >
                {value === 'all' ? t('common:actions.all') : t(`common:status.${value}`)}
              </Button>
            ))}
          </div>
        }
        chips={
          status !== 'all' ? (
            <Button size="sm" variant="ghost" onClick={() => setStatus('all')}>
              {t('common:actions.clearFilters')}
            </Button>
          ) : null
        }
      />
      <div className="mt-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        ) : isError ? (
          <p className="text-sm text-danger">{t('loadFailed')}</p>
        ) : all.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : items.length === 0 ? (
          <EmptyState title={t('noMatches.title')} description={t('noMatches.description')} actionLabel={t('common:actions.clearFilters')} onAction={() => { setSearch(''); setStatus('all'); }} />
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((item) => (
              <RunCard
                key={item.id}
                item={item}
                workspaceSlug={workspaceSlug}
                expanded={expandedRunId === item.id}
                onToggle={() => setExpandedRunId(expandedRunId === item.id ? null : item.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

type RunCardProps = {
  item: RunView;
  workspaceSlug: string;
  expanded: boolean;
  onToggle: () => void;
};

function RunCard({ item, workspaceSlug, expanded, onToggle }: RunCardProps) {
  const { t } = useTranslation(['runs', 'common']);
  const { locale } = useLocale();
  const { data: run, isLoading, isError } = useRunQuery(workspaceSlug, item.id, expanded);
  const artifacts = run?.artifacts ?? [];

  return (
    <li>
      <article className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:gap-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={`run-card-${item.id}`}
            className="grid min-w-0 flex-1 gap-3 rounded-md text-left transition-colors duration-[120ms] hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45 md:grid-cols-[minmax(0,1.6fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto] md:items-center md:gap-3 md:px-2 md:py-1"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{item.workflowName}</span>
              <span className="font-mono text-xs text-muted-foreground">{item.version}</span>
            </span>
            <StatusBadge status={toUiStatus(item.status)} />
            <span className="truncate text-[13px] text-muted-foreground">{item.currentStep ?? t('common:empty.dash')}</span>
            <span className="tabular-nums text-[13px]">{formatDateTime(item.startedAt, locale)}</span>
            <span className="tabular-nums text-[13px] text-muted-foreground">
              {item.durationSeconds == null ? t('common:empty.dash') : t('common:duration.compact', durationParts(item.durationSeconds))}
            </span>
            <ChevronDown className={cn('size-4 shrink-0 justify-self-end text-muted-foreground transition-transform duration-[120ms]', expanded && 'rotate-180')} aria-hidden="true" />
          </button>
          <div className="flex shrink-0 items-center justify-end">
            <Button asChild size="compact" variant="secondary">
              <Link to="/runs/$runId" params={{ runId: item.id }}>{t('openDetails')}</Link>
            </Button>
          </div>
        </div>
        <div id={`run-card-${item.id}`} hidden={!expanded} className="border-t border-border px-4 py-3">
          {expanded ? (
            <section aria-labelledby={`run-card-${item.id}-artifacts`}>
              <div className="flex items-center gap-2">
                <FileStack className="size-4 text-muted-foreground" aria-hidden="true" />
                <h3 id={`run-card-${item.id}-artifacts`} className="text-sm font-semibold">{t('artifacts')}</h3>
              </div>
              {isLoading ? (
                <p className="mt-2 flex items-center gap-2 text-[13px] text-muted-foreground">
                  <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                  {t('artifactsLoading')}
                </p>
              ) : isError ? (
                <p className="mt-2 text-[13px] text-danger">{t('artifactsFailed')}</p>
              ) : artifacts.length === 0 ? (
                <p className="mt-2 text-[13px] text-muted-foreground">{t('noArtifacts')}</p>
              ) : (
                <ul className="mt-2 grid gap-2 lg:grid-cols-2">
                  {artifacts.map((artifact) => (
                    <ArtifactRow key={artifact.id} artifact={artifact} locale={locale} />
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </div>
      </article>
    </li>
  );
}

type ArtifactRowProps = {
  artifact: ArtifactView;
  locale: string;
};

function ArtifactRow({ artifact, locale }: ArtifactRowProps) {
  return (
    <li>
      <Link
        to="/artifacts/$artifactId"
        params={{ artifactId: artifact.id }}
        className="flex flex-col gap-1 rounded-md border border-border bg-surface px-3 py-2 transition-colors duration-[120ms] hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:grid sm:grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,0.7fr)_minmax(0,1fr)] sm:items-center sm:gap-3"
      >
        <span className="truncate text-sm font-medium">{artifact.name}</span>
        <span className="text-[13px] text-muted-foreground">{artifact.type}</span>
        <span className="tabular-nums text-[13px] text-muted-foreground">{artifact.size}</span>
        <span className="tabular-nums text-[13px]">{formatDateTime(artifact.createdAt, locale)}</span>
      </Link>
    </li>
  );
}
