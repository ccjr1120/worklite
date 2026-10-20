import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AgentResourceNav } from '@/components/agent-resource-nav';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { CollectionLoading } from '@/components/collection-loading';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { McpServerDeleteDialog } from '@/features/mcp-servers/delete-dialog';
import { useMcpServersQuery } from '@/api/queries';

export const Route = createFileRoute('/mcp-servers/')({
  component: McpListPage,
});

function McpListPage() {
  const { t } = useTranslation(['mcpServers', 'common']);
  const workspaceSlug = "personal";
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<(typeof all)[number] | null>(null);
  const { data: all = [], isLoading, isError, refetch } = useMcpServersQuery(workspaceSlug);
  const items = useMemo(() => all.filter((item) => item.name.toLowerCase().includes(search.toLowerCase())), [all, search]);

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
      <WorkspaceChrome
        crumbs={[{ label: t('title') }]}
      />
      <PageHeading title={t('title')} />
      <AgentResourceNav active="mcp-servers" />
      <CollectionToolbar
        className="mt-6"
        search={search}
        onSearchChange={setSearch}
        placeholder={t('search')}
        actions={
          <Button asChild>
            <Link to="/mcp-servers/$serverId" params={{ serverId: 'new' }}>
              <Plus className="size-4" />
              {t('create')}
            </Link>
          </Button>
        }
      />
      <div className="mt-4">
        {isLoading ? <CollectionLoading label={t('loading')} columns={[t('columns.server'), t('columns.connection'), t('columns.transport'), t('columns.allowedTools'), t('columns.version'), t('columns.actions')]} headerClassName="min-w-[860px] grid-cols-[2fr_1fr_1fr_1fr_1fr_40px]" rowClassName="min-w-[860px] whitespace-nowrap grid-cols-[2fr_1fr_1fr_1fr_1fr_40px]" /> : isError ? <ErrorState title={t('title')} description={t('loadFailed')} onAction={() => void refetch()} /> : all.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : items.length === 0 ? (
          <EmptyState title={t('noMatches.title')} description={t('noMatches.description', { search })} actionLabel={t('common:actions.clearFilters')} onAction={() => setSearch('')} />
        ) : (
          <CollectionTable>
            <CollectionHeader className="min-w-[860px] grid-cols-[2fr_1fr_1fr_1fr_1fr_40px]" columns={[t('columns.server'), t('columns.connection'), t('columns.transport'), t('columns.allowedTools'), t('columns.version'), t('columns.actions')]} />
            {items.map((item) => (
              <CollectionRow key={item.id} className="min-w-[860px] whitespace-nowrap grid-cols-[2fr_1fr_1fr_1fr_1fr_40px]">
                <Link to="/mcp-servers/$serverId" params={{ serverId: item.id }} className="contents">
                  <span className="font-medium">{item.name}</span>
                  <StatusBadge status={item.connection} />
                  <span className="text-[13px] text-muted-foreground">{item.transport}</span>
                  <span className="tabular-nums text-[13px]">{item.allowedTools}</span>
                  <span className="font-mono text-[13px]">{item.version}</span>
                </Link>
                <Button type="button" variant="ghost" size="icon-compact" className="text-danger hover:text-danger" aria-label={t('delete.action', { name: item.name })} onClick={() => setDeleteTarget(item)}><Trash2 className="size-4" /></Button>
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
