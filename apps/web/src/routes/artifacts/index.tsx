import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeading } from '@/components/page-heading';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { useArtifactsQuery } from '@/api/queries';

export const Route = createFileRoute('/artifacts/')({
  component: ArtifactListPage,
});

function ArtifactListPage() {
  const { t } = useTranslation(['artifacts', 'common']);
  const { locale } = useLocale();
  const workspaceSlug = "personal";
  const [search, setSearch] = useState('');
  const { data: all = [], isLoading, isError } = useArtifactsQuery(workspaceSlug);
  const items = useMemo(
    () => all.filter((item) => `${item.name} ${item.workflowName}`.toLowerCase().includes(search.toLowerCase())),
    [all, search],
  );

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
      <WorkspaceChrome crumbs={[{ label: t('title') }]} />
      <PageHeading title={t('title')} description={t('description')} />
      <CollectionToolbar className="mt-6" search={search} onSearchChange={setSearch} placeholder={t('search')} />
      <div className="mt-4">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading artifacts...</p> : isError ? <p className="text-sm text-danger">Unable to load artifacts.</p> : all.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : items.length === 0 ? (
          <EmptyState title={t('noMatches.title')} description={t('noMatches.description', { search })} actionLabel={t('common:actions.clearFilters')} onAction={() => setSearch('')} />
        ) : (
          <CollectionTable>
            <CollectionHeader columns={[t('columns.artifact'), t('columns.type'), t('columns.workflow'), t('columns.size'), t('columns.created')]} />
            {items.map((item) => (
              <Link key={item.id} to="/artifacts/$artifactId" params={{ artifactId: item.id }} className="block">
                <CollectionRow>
                  <span className="font-mono text-sm">{item.name}</span>
                  <span className="text-[13px] uppercase text-muted-foreground">{item.type}</span>
                  <span className="truncate text-[13px]">{item.workflowName}</span>
                  <span className="tabular-nums text-[13px]">{item.size}</span>
                  <span className="tabular-nums text-[13px] text-muted-foreground">{formatDateTime(item.createdAt, locale)}</span>
                </CollectionRow>
              </Link>
            ))}
          </CollectionTable>
        )}
      </div>
    </div>
  );
}
