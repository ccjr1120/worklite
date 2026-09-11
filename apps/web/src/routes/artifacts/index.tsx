import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeading } from '@/components/page-heading';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { artifactsQueryKey, useArtifactsQuery } from '@/api/queries';
import { api } from '@/api/client';
import { queryClient } from '@/lib/query-client';

export const Route = createFileRoute('/artifacts/')({
  component: ArtifactListPage,
});

function ArtifactListPage() {
  const { t } = useTranslation(['artifacts', 'common']);
  const { locale } = useLocale();
  const workspaceSlug = "personal";
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<(typeof all)[number] | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const { data: all = [], isLoading, isError } = useArtifactsQuery(workspaceSlug);
  const items = useMemo(
    () => all.filter((item) => `${item.name} ${item.workflowName}`.toLowerCase().includes(search.toLowerCase())),
    [all, search],
  );

  async function deleteArtifact() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await api.deleteArtifact(workspaceSlug, deleteTarget.id);
      setDeleteTarget(null);
      toast.success(t('delete.success'));
      await queryClient.invalidateQueries({ queryKey: artifactsQueryKey() });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t('delete.failed'));
    } finally {
      setDeleteBusy(false);
    }
  }

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
            <CollectionHeader className="min-w-[900px] grid-cols-[2fr_1fr_1.4fr_0.7fr_1fr_40px]" columns={[t('columns.artifact'), t('columns.type'), t('columns.workflow'), t('columns.size'), t('columns.created'), t('columns.actions')]} />
            {items.map((item) => (
              <CollectionRow key={item.id} className="min-w-[900px] whitespace-nowrap grid-cols-[2fr_1fr_1.4fr_0.7fr_1fr_40px]">
                <Link to="/artifacts/$artifactId" params={{ artifactId: item.id }} className="contents">
                  <span className="font-mono text-sm">{item.name}</span>
                  <span className="text-[13px] uppercase text-muted-foreground">{item.type}</span>
                  <span className="truncate text-[13px]">{item.workflowName}</span>
                  <span className="tabular-nums text-[13px]">{item.size}</span>
                  <span className="tabular-nums text-[13px] text-muted-foreground">{formatDateTime(item.createdAt, locale)}</span>
                </Link>
                <Button type="button" variant="ghost" size="icon-compact" className="text-danger hover:text-danger" aria-label={t('delete.action', { name: item.name })} onClick={() => { setDeleteError(''); setDeleteTarget(item); }}><Trash2 className="size-4" /></Button>
              </CollectionRow>
            ))}
          </CollectionTable>
        )}
      </div>
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !deleteBusy) setDeleteTarget(null); }}><DialogContent><DialogHeader><DialogTitle>{t('delete.title', { name: deleteTarget?.name ?? '' })}</DialogTitle><DialogDescription>{t('delete.description')}</DialogDescription></DialogHeader>{deleteError ? <p className="text-[13px] text-danger" role="alert">{deleteError}</p> : null}<DialogFooter><Button variant="secondary" disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>{t('common:actions.cancel')}</Button><Button variant="destructive" disabled={deleteBusy} onClick={() => void deleteArtifact()}>{deleteBusy ? t('delete.deleting') : t('common:actions.delete')}</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}
