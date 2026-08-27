import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { useWorkflowsQuery } from '@/api/queries';

export const Route = createFileRoute('/workflows/')({
  component: WorkflowListPage,
});

function WorkflowListPage() {
  const { t } = useTranslation(['workflows', 'common']);
  const { locale } = useLocale();
  const workspaceSlug = "personal";
  const [search, setSearch] = useState('');
  const { data: all = [], isLoading, isError } = useWorkflowsQuery(workspaceSlug);
  const items = useMemo(
    () => all.filter((item) => item.name.toLowerCase().includes(search.toLowerCase())),
    [all, search],
  );

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
      <WorkspaceChrome
        crumbs={[{ label: t('title') }]}
        actions={
          <Button asChild size="compact">
            <Link to="/workflows/$workflowId" params={{ workflowId: 'new' }}>
              <Plus className="size-4" />
              {t('create')}
            </Link>
          </Button>
        }
      />
      <PageHeading title={t('title')} description={t('description')} />
      <CollectionToolbar className="mt-6" search={search} onSearchChange={setSearch} placeholder={t('search')} />
      <div className="mt-4">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading workflows...</p> : isError ? <p className="text-sm text-danger">Unable to load workflows.</p> : all.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : items.length === 0 ? (
          <EmptyState title={t('noMatches.title')} description={t('noMatches.description', { search })} actionLabel={t('common:actions.clearFilters')} onAction={() => setSearch('')} />
        ) : (
          <CollectionTable>
            <CollectionHeader columns={[t('columns.workflow'), t('columns.state'), t('columns.steps'), t('columns.lastRun'), t('columns.updated')]} />
            {items.map((item) => (
              <Link key={item.id} to="/workflows/$workflowId" params={{ workflowId: item.id }} className="block">
                <CollectionRow>
                  <span className="truncate text-sm font-medium">{item.name}</span>
                  <StatusBadge status={item.state} />
                  <span className="tabular-nums text-[13px]">{item.stepCount}</span>
                  <span className="flex items-center gap-2 text-[13px]">
                    {item.lastRunStatus ? <StatusBadge status={item.lastRunStatus === 'succeeded' ? 'completed' : item.lastRunStatus === 'timed_out' ? 'failed' : item.lastRunStatus} /> : t('common:empty.dash')}
                    <span className="tabular-nums text-muted-foreground">{item.lastRunAt ? formatDateTime(item.lastRunAt, locale) : ''}</span>
                  </span>
                  <span className="tabular-nums text-[13px] text-muted-foreground">{formatDateTime(item.updatedAt, locale)}</span>
                </CollectionRow>
              </Link>
            ))}
          </CollectionTable>
        )}
      </div>
    </div>
  );
}
