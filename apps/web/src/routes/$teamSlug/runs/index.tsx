import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { durationParts, formatDateTime } from '@/i18n/format';
import { filterByTeam, runs, type RunUiStatus } from '@/mock/data';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/$teamSlug/runs/')({
  component: RunListPage,
});

function RunListPage() {
  const { t } = useTranslation(['runs', 'common']);
  const { locale } = useLocale();
  const { teamSlug } = Route.useParams();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<RunUiStatus | 'all'>('all');
  const all = filterByTeam(runs, teamSlug);
  const items = useMemo(
    () =>
      all.filter((item) => {
        const matchesSearch = `${item.workflowName} ${item.initiator} ${item.id}`.toLowerCase().includes(search.toLowerCase());
        const matchesStatus = status === 'all' || item.status === status;
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
        {all.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : items.length === 0 ? (
          <EmptyState title={t('noMatches.title')} description={t('noMatches.description')} actionLabel={t('common:actions.clearFilters')} onAction={() => { setSearch(''); setStatus('all'); }} />
        ) : (
          <CollectionTable>
            <CollectionHeader columns={[t('columns.workflow'), t('columns.status'), t('columns.currentStep'), t('columns.started'), t('columns.duration')]} />
            {items.map((item) => (
              <Link key={item.id} to="/$teamSlug/runs/$runId" params={{ teamSlug, runId: item.id }} className="block">
                <CollectionRow>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{item.workflowName}</span>
                    <span className="font-mono text-xs text-muted-foreground">{item.version}</span>
                  </span>
                  <StatusBadge status={item.status} />
                  <span className="truncate text-[13px] text-muted-foreground">{item.currentStep ?? t('common:empty.dash')}</span>
                  <span className="tabular-nums text-[13px]">{formatDateTime(item.startedAt, locale)}</span>
                  <span className="tabular-nums text-[13px] text-muted-foreground">
                    {item.durationSeconds == null ? t('common:empty.dash') : t('common:duration.compact', durationParts(item.durationSeconds))}
                  </span>
                </CollectionRow>
              </Link>
            ))}
          </CollectionTable>
        )}
      </div>
    </div>
  );
}
