import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AgentResourceNav } from '@/components/agent-resource-nav';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { mcpServersQueryKey, useMcpServersQuery } from '@/api/queries';
import { api } from '@/api/client';
import { queryClient } from '@/lib/query-client';
import { toast } from 'sonner';

export const Route = createFileRoute('/mcp-servers/')({
  component: McpListPage,
});

function McpListPage() {
  const { t } = useTranslation(['mcpServers', 'common']);
  const workspaceSlug = "personal";
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<(typeof all)[number] | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const { data: all = [], isLoading, isError } = useMcpServersQuery(workspaceSlug);
  const items = useMemo(() => all.filter((item) => item.name.toLowerCase().includes(search.toLowerCase())), [all, search]);

  async function deleteResource() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await api.deleteMcpServer(workspaceSlug, deleteTarget.id);
      setDeleteTarget(null);
      toast.success(t('delete.success'));
      await queryClient.invalidateQueries({ queryKey: mcpServersQueryKey() });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t('delete.failed'));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
      <WorkspaceChrome
        crumbs={[{ label: t('title') }]}
      />
      <PageHeading title={t('title')} description={t('description')} />
      <AgentResourceNav active="mcp-servers" />
      <CollectionToolbar
        className="mt-6"
        search={search}
        onSearchChange={setSearch}
        placeholder={t('search')}
        actions={
          <Button asChild size="compact">
            <Link to="/mcp-servers/$serverId" params={{ serverId: 'new' }}>
              <Plus className="size-4" />
              {t('create')}
            </Link>
          </Button>
        }
      />
      <div className="mt-4">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading MCP servers...</p> : isError ? <p className="text-sm text-danger">Unable to load MCP servers.</p> : all.length === 0 ? (
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
                <Button type="button" variant="ghost" size="icon-compact" className="text-danger hover:text-danger" aria-label={t('delete.action', { name: item.name })} onClick={() => { setDeleteError(''); setDeleteTarget(item); }}><Trash2 className="size-4" /></Button>
              </CollectionRow>
            ))}
          </CollectionTable>
        )}
      </div>
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !deleteBusy) setDeleteTarget(null); }}><DialogContent><DialogHeader><DialogTitle>{t('delete.title', { name: deleteTarget?.name ?? '' })}</DialogTitle><DialogDescription>{t('delete.description')}</DialogDescription></DialogHeader>{deleteError ? <p className="text-[13px] text-danger" role="alert">{deleteError}</p> : null}<DialogFooter><Button variant="secondary" disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>{t('common:actions.cancel')}</Button><Button variant="destructive" disabled={deleteBusy} onClick={() => void deleteResource()}>{deleteBusy ? t('delete.deleting') : t('common:actions.delete')}</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}
