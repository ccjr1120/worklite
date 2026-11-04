import { createFileRoute, Link } from '@tanstack/react-router';
import { Puzzle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePluginsQuery } from '@/api/queries';
import { CollectionLoading } from '@/components/collection-loading';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';

export const Route = createFileRoute('/plugins/')({
  component: PluginListPage,
});

function PluginListPage() {
  const { t: tPlugins } = useTranslation('plugins');
  const { t: tCommon } = useTranslation('common');
  const [search, setSearch] = useState('');
  const { data: plugins = [], isLoading, isError, refetch } = usePluginsQuery();
  const visiblePlugins = useMemo(
    () => plugins.filter((plugin) => plugin.id !== 'feishu-bot' && plugin.id !== 'wechat-bot'),
    [plugins],
  );
  const items = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return visiblePlugins
      .filter((plugin) => !normalizedSearch || `${plugin.name} ${plugin.description} ${plugin.command} ${plugin.status}`.toLowerCase().includes(normalizedSearch))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [search, visiblePlugins]);

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
      <WorkspaceChrome crumbs={[{ label: tPlugins('title') }]} />
      <PageHeading title={tPlugins('title')} />
      <CollectionToolbar className="mt-6" search={search} onSearchChange={setSearch} placeholder={tPlugins('search')} />
      <div className="mt-4">
        {isLoading ? (
          <CollectionLoading
            label={tPlugins('loading')}
            columns={[tPlugins('columns.plugin'), tPlugins('columns.availability')]}
            headerClassName="grid-cols-[minmax(0,1fr)_140px]"
            rowClassName="grid-cols-1 md:grid-cols-[minmax(0,1fr)_140px]"
          />
        ) : isError ? (
          <ErrorState title={tPlugins('title')} description={tPlugins('loadFailed')} onAction={() => void refetch()} />
        ) : visiblePlugins.length === 0 ? (
          <EmptyState title={tPlugins('empty.title')} description={tPlugins('empty.description')} />
        ) : items.length === 0 ? (
          <EmptyState title={tPlugins('noMatches.title')} description={tPlugins('noMatches.description', { search })} actionLabel={tCommon('actions.clearFilters')} onAction={() => setSearch('')} />
        ) : (
          <CollectionTable>
            <CollectionHeader
              className="grid-cols-[minmax(0,1fr)_140px]"
              columns={[tPlugins('columns.plugin'), tPlugins('columns.availability')]}
            />
            {items.map((plugin) => (
              <Link key={plugin.id} to="/plugins/$pluginId" params={{ pluginId: plugin.id }} className="block">
                <CollectionRow className="grid-cols-1 md:grid-cols-[minmax(0,1fr)_140px]">
                  <span className="flex min-w-0 items-center gap-3">
                    <Puzzle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{plugin.name}</span>
                      {plugin.description ? <span className="block truncate text-[13px] text-muted-foreground">{plugin.description}</span> : null}
                    </span>
                  </span>
                  <StatusBadge status={plugin.status} />
                </CollectionRow>
              </Link>
            ))}
          </CollectionTable>
        )}
      </div>
    </div>
  );
}
