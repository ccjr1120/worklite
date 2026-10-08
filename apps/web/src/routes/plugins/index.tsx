import { createFileRoute, Link } from '@tanstack/react-router';
import { Puzzle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePluginsQuery } from '@/api/queries';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { CollectionLoading } from '@/components/collection-loading';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';

export const Route = createFileRoute('/plugins/')({
  component: PluginListPage,
});

function PluginListPage() {
  const { t: tPlugins } = useTranslation('plugins');
  const { t: tCommon } = useTranslation('common');
  const { locale } = useLocale();
  const [search, setSearch] = useState('');
  const { data: plugins = [], isLoading, isError, refetch } = usePluginsQuery();
  const visiblePlugins = plugins.filter((plugin) => plugin.id !== 'feishu-bot');
  const items = useMemo(() => plugins.filter((plugin) => plugin.id !== 'feishu-bot').filter((plugin) => `${plugin.name} ${plugin.description} ${plugin.command}`.toLowerCase().includes(search.toLowerCase())), [plugins, search]);

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
      <WorkspaceChrome crumbs={[{ label: tPlugins('title') }]} />
      <PageHeading title={tPlugins('title')} />
      <CollectionToolbar className="mt-6" search={search} onSearchChange={setSearch} placeholder={tPlugins('search')} />
      <div className="mt-4">
        {isLoading ? <CollectionLoading label={tPlugins('loading')} columns={[tPlugins('columns.plugin'), tPlugins('columns.command'), tPlugins('columns.availability'), tPlugins('columns.updated')]} headerClassName="grid-cols-[2fr_2fr_1fr_1fr]" rowClassName="grid-cols-1 md:grid-cols-[2fr_2fr_1fr_1fr]" /> : isError ? <ErrorState title={tPlugins('title')} description={tPlugins('loadFailed')} onAction={() => void refetch()} /> : visiblePlugins.length === 0 ? (
          <EmptyState title={tPlugins('empty.title')} description={tPlugins('empty.description')} />
        ) : items.length === 0 ? (
          <EmptyState title={tPlugins('noMatches.title')} description={tPlugins('noMatches.description', { search })} actionLabel={tCommon('actions.clearFilters')} onAction={() => setSearch('')} />
        ) : (
          <CollectionTable>
            <CollectionHeader className="grid-cols-[2fr_2fr_1fr_1fr]" columns={[tPlugins('columns.plugin'), tPlugins('columns.command'), tPlugins('columns.availability'), tPlugins('columns.updated')]} />
            {items.map((plugin) => (
              <Link key={plugin.id} to="/plugins/$pluginId" params={{ pluginId: plugin.id }} className="block">
                <CollectionRow className="grid-cols-1 md:grid-cols-[2fr_2fr_1fr_1fr]">
                  <span className="flex min-w-0 items-center gap-3"><Puzzle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0"><span className="block truncate text-sm font-medium">{plugin.name}</span><span className="block truncate text-[13px] text-muted-foreground">{plugin.description}</span></span></span>
                  <code className="truncate text-[13px] text-muted-foreground">{plugin.command}</code>
                  <StatusBadge status={plugin.status} />
                  <span className="tabular-nums text-[13px] text-muted-foreground">{formatDateTime(plugin.updatedAt, locale)}</span>
                </CollectionRow>
              </Link>
            ))}
          </CollectionTable>
        )}
      </div>
    </div>
  );
}
