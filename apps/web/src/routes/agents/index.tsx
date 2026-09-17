import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Blocks, Plus, Server, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { AgentMark } from '@/components/agent-mark';
import { AgentResourceNav } from '@/components/agent-resource-nav';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { CollectionLoading } from '@/components/collection-loading';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeading } from '@/components/page-heading';
import { Button } from '@/components/ui/button';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime, formatList } from '@/i18n/format';
import { agentsQueryKey, useAgentsQuery } from '@/api/queries';
import { api } from '@/api/client';
import { queryClient } from '@/lib/query-client';
import { toast } from 'sonner';

export const Route = createFileRoute('/agents/')({
  component: AgentListPage,
});

function AgentListPage() {
  const { t } = useTranslation(['agents', 'common']);
  const { locale } = useLocale();
  const workspaceSlug = "personal";
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<(typeof all)[number] | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const { data: all = [], isLoading, isError, refetch } = useAgentsQuery(workspaceSlug);
  const items = useMemo(() => {
    return all.filter((item) => item.kind === 'custom').filter((item) =>
      `${item.name} ${item.responsibility} ${item.model} ${item.providerName ?? ''} ${item.skills.map((skill) => skill.name).join(' ')} ${item.mcpServers.map((server) => server.name).join(' ')}`.toLowerCase().includes(search.toLowerCase()),
    );
  }, [all, search]);

  async function deleteAgent() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await api.deleteAgent(workspaceSlug, deleteTarget.id);
      setDeleteTarget(null);
      toast.success(t('delete.success'));
      await queryClient.invalidateQueries({ queryKey: agentsQueryKey() });
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
      <AgentResourceNav active="agents" />
      <CollectionToolbar
        className="mt-6"
        search={search}
        onSearchChange={setSearch}
        placeholder={t('search')}
        actions={
          <Button asChild size="compact">
            <Link to="/agents/$agentId" params={{ agentId: 'new' }}>
              <Plus className="size-4" />
              {t('create')}
            </Link>
          </Button>
        }
      />
      <div className="mt-4">
        {isLoading ? <CollectionLoading label={t('loading')} columns={[t('columns.agent'), t('columns.model'), t('columns.resources'), t('columns.updated'), t('columns.actions')]} headerClassName="min-w-[940px] grid-cols-[2fr_1.25fr_1.5fr_1fr_40px]" rowClassName="min-w-[940px] whitespace-nowrap grid-cols-[2fr_1.25fr_1.5fr_1fr_40px]" /> : isError ? <ErrorState title={t('title')} description={t('loadFailed')} onAction={() => void refetch()} /> : all.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} actionLabel={t('create')} onAction={() => void navigate({ to: '/agents/$agentId', params: { agentId: 'new' } })} />
        ) : items.length === 0 ? (
          <EmptyState title={t('noMatches.title')} description={t('noMatches.description', { search })} actionLabel={t('common:actions.clearFilters')} onAction={() => setSearch('')} />
        ) : (
          <CollectionTable>
            <CollectionHeader className="min-w-[940px] grid-cols-[2fr_1.25fr_1.5fr_1fr_40px] [&>span:last-child]:text-center" columns={[t('columns.agent'), t('columns.model'), t('columns.resources'), t('columns.updated'), t('columns.actions')]} />
            {items.map((item) => (
              <CollectionRow key={item.id} className="min-w-[940px] whitespace-nowrap grid-cols-[2fr_1.25fr_1.5fr_1fr_40px]">
                <Link to="/agents/$agentId" params={{ agentId: item.id }} className="contents">
                  <span className="flex min-w-0 items-center gap-3">
                    <AgentMark initials={item.initials} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{item.name}</span>
                      </span>
                      <span className="block truncate text-[13px] text-muted-foreground">{item.responsibility}</span>
                    </span>
                  </span>
                  <span className="text-[13px]">{[item.providerName, item.model].filter(Boolean).join(' / ') || t('notConfigured')}</span>
                  <span className="min-w-0 space-y-1 text-[13px] text-muted-foreground">
                    <span className="flex min-w-0 items-center gap-2"><Blocks className="size-3.5 shrink-0" aria-hidden="true" /><span className="truncate"><span className="sr-only">{t('editor.skills')}: </span>{formatList(item.skills.map((skill) => skill.name), locale) || t('common:empty.dash')}</span></span>
                    <span className="flex min-w-0 items-center gap-2"><Server className="size-3.5 shrink-0" aria-hidden="true" /><span className="truncate"><span className="sr-only">{t('editor.mcpServers')}: </span>{formatList(item.mcpServers.map((server) => server.name), locale) || t('common:empty.dash')}</span></span>
                  </span>
                  <span className="tabular-nums text-[13px] text-muted-foreground">{formatDateTime(item.updatedAt, locale)}</span>
                </Link>
                <Button type="button" variant="ghost" size="icon-compact" className="mx-auto text-danger hover:text-danger" aria-label={t('delete.action', { name: item.name })} onClick={() => { setDeleteError(''); setDeleteTarget(item); }}><Trash2 className="size-4" /></Button>
              </CollectionRow>
            ))}
          </CollectionTable>
        )}
      </div>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => { if (!nextOpen && !deleteBusy) setDeleteTarget(null); }}
        title={t('delete.title', { name: deleteTarget?.name ?? '' })}
        description={t('delete.description')}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        busyLabel={t('delete.deleting')}
        error={deleteError}
        busy={deleteBusy}
        onConfirm={() => void deleteAgent()}
      />
    </div>
  );
}
