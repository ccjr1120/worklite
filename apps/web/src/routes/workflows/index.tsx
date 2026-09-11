import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import { FileUp, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { api } from '@/api/client';
import { useWorkflowsQuery, workflowsQueryKey } from '@/api/queries';
import { queryClient } from '@/lib/query-client';

export const Route = createFileRoute('/workflows/')({
  component: WorkflowListPage,
});

function WorkflowListPage() {
  const { t } = useTranslation(['workflows', 'common']);
  const { locale } = useLocale();
  const workspaceSlug = "personal";
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<(typeof all)[number] | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);
  const { data: all = [], isLoading, isError } = useWorkflowsQuery(workspaceSlug);
  async function importWorkflow(file: File | undefined) {
    if (!file) return;
    setImporting(true);
    try {
      const document = JSON.parse(await file.text()) as Parameters<typeof api.importWorkflow>[1];
      const workflow = await api.importWorkflow(workspaceSlug, document);
      await queryClient.invalidateQueries({ queryKey: workflowsQueryKey() });
      window.location.assign(`/workflows/${encodeURIComponent(workflow.id)}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('importFailed'));
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = '';
    }
  }

  const items = useMemo(
    () => all.filter((item) => item.name.toLowerCase().includes(search.toLowerCase())),
    [all, search],
  );

  async function deleteWorkflow() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await api.deleteWorkflow(workspaceSlug, deleteTarget.id);
      setDeleteTarget(null);
      setDeleteError('');
      toast.success(t('delete.success'));
      await queryClient.invalidateQueries({ queryKey: workflowsQueryKey() });
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
        actions={
          <div className="flex items-center gap-2">
            <input ref={importInputRef} type="file" accept="application/json,.json" className="sr-only" onChange={(event) => void importWorkflow(event.target.files?.[0])} />
            <Button type="button" variant="secondary" size="compact" disabled={importing} onClick={() => importInputRef.current?.click()}>
              <FileUp className="size-4" />
              {importing ? t('importing') : t('importJson')}
            </Button>
            <Button asChild size="compact">
              <Link to="/workflows/$workflowId" params={{ workflowId: 'new' }}>
                <Plus className="size-4" />
                {t('create')}
              </Link>
            </Button>
          </div>
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
            <CollectionHeader className="min-w-[980px] md:grid-cols-[minmax(220px,2fr)_minmax(110px,1fr)_minmax(72px,0.6fr)_minmax(210px,1.4fr)_minmax(170px,1fr)_40px]" columns={[t('columns.workflow'), t('columns.state'), t('columns.steps'), t('columns.lastRun'), t('columns.updated'), t('columns.actions')]} />
            {items.map((item) => (
              <CollectionRow key={item.id} className="min-w-[980px] whitespace-nowrap md:grid-cols-[minmax(220px,2fr)_minmax(110px,1fr)_minmax(72px,0.6fr)_minmax(210px,1.4fr)_minmax(170px,1fr)_40px]">
                <Link to="/workflows/$workflowId" params={{ workflowId: item.id }} className="min-w-0 truncate text-sm font-medium hover:underline" title={item.name}>{item.name}</Link>
                <StatusBadge status={item.state} />
                <span className="tabular-nums text-[13px]">{item.stepCount}</span>
                <span className="flex items-center gap-2 whitespace-nowrap text-[13px]">
                  {item.lastRunStatus ? <StatusBadge status={item.lastRunStatus === 'succeeded' ? 'completed' : item.lastRunStatus === 'timed_out' ? 'failed' : item.lastRunStatus} /> : t('common:empty.dash')}
                  <span className="tabular-nums text-muted-foreground">{item.lastRunAt ? formatDateTime(item.lastRunAt, locale) : ''}</span>
                </span>
                <span className="whitespace-nowrap tabular-nums text-[13px] text-muted-foreground">{formatDateTime(item.updatedAt, locale)}</span>
                <Button type="button" variant="ghost" size="icon-compact" className="text-danger hover:text-danger" aria-label={t('delete.action', { name: item.name })} onClick={() => { setDeleteError(''); setDeleteTarget(item); }}><Trash2 className="size-4" /></Button>
              </CollectionRow>
            ))}
          </CollectionTable>
        )}
      </div>
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !deleteBusy) { setDeleteTarget(null); setDeleteError(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('delete.title', { name: deleteTarget?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('delete.description')}</DialogDescription>
          </DialogHeader>
          {deleteError ? <p className="text-[13px] text-danger" role="alert">{deleteError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>{t('common:actions.cancel')}</Button>
            <Button type="button" variant="destructive" disabled={deleteBusy} onClick={() => void deleteWorkflow()}>{deleteBusy ? t('delete.deleting') : t('common:actions.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
