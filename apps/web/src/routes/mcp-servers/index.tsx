import { createFileRoute, Link } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMcpServersQuery } from '@/api/queries';
import { CollectionLoading } from '@/components/collection-loading';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { McpServerDeleteDialog } from '@/features/mcp-servers/delete-dialog';

export const Route = createFileRoute('/mcp-servers/')({
  component: McpListPage,
});

const tableClassName = 'min-w-[860px] grid-cols-[minmax(0,2fr)_1fr_1fr_1fr_1fr_80px]';

function McpListPage() {
  const { t } = useTranslation(['mcpServers', 'common']);
  const workspaceSlug = 'personal';
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<(typeof all)[number] | null>(null);
  const { data: all = [], isLoading, isError, refetch } = useMcpServersQuery(workspaceSlug);
  const items = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return all
      .filter((server) => !normalizedSearch || `${server.name} ${server.endpoint} ${server.transport} ${server.version} ${server.allowedToolNames.join(' ')}`.toLowerCase().includes(normalizedSearch))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [all, search]);

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
      <WorkspaceChrome crumbs={[{ label: t('title') }]} />
      <PageHeading title={t('title')} />
      <CollectionToolbar
        className="mt-6"
        search={search}
        onSearchChange={setSearch}
        placeholder={t('search')}
        actions={
          <Button asChild>
            <Link to="/mcp-servers/$serverId" params={{ serverId: 'new' }}>
              <Plus className="size-4" aria-hidden="true" />
              {t('create')}
            </Link>
          </Button>
        }
      />
      <div className="mt-4">
        {isLoading ? (
          <CollectionLoading
            label={t('loading')}
            columns={[t('columns.server'), t('columns.connection'), t('columns.transport'), t('columns.allowedTools'), t('columns.version'), t('columns.actions')]}
            headerClassName={tableClassName}
            rowClassName={tableClassName}
          />
        ) : isError ? (
          <ErrorState title={t('title')} description={t('loadFailed')} onAction={() => void refetch()} />
        ) : all.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : items.length === 0 ? (
          <EmptyState title={t('noMatches.title')} description={t('noMatches.description', { search })} actionLabel={t('common:actions.clearFilters')} onAction={() => setSearch('')} />
        ) : (
          <CollectionTable>
            <CollectionHeader className={tableClassName} columns={[t('columns.server'), t('columns.connection'), t('columns.transport'), t('columns.allowedTools'), t('columns.version'), t('columns.actions')]} />
            {items.map((server) => (
              <CollectionRow key={server.id} className={tableClassName}>
                <Link to="/mcp-servers/$serverId" params={{ serverId: server.id }} className="contents">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{server.name}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{server.endpoint}</span>
                  </span>
                  <StatusBadge status={server.connection} />
                  <span className="text-[13px] text-muted-foreground">{server.transport}</span>
                  <span className="tabular-nums text-[13px]">{server.allowedTools}</span>
                  <span className="font-mono text-[13px]">{server.version}</span>
                </Link>
                <Button type="button" variant="ghost" size="icon-compact" className="text-danger hover:text-danger" data-row-action aria-label={t('delete.action', { name: server.name })} title={t('delete.action', { name: server.name })} onClick={() => setDeleteTarget(server)}>
                  <Trash2 className="size-4" />
                </Button>
              </CollectionRow>
            ))}
          </CollectionTable>
        )}
      </div>
      <McpServerDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => { if (!nextOpen) setDeleteTarget(null); }}
        serverId={deleteTarget?.id ?? ''}
        name={deleteTarget?.name ?? ''}
        onDeleted={() => setDeleteTarget(null)}
      />
    </div>
  );
}
