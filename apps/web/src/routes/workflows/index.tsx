import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import { FileUp, History, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { CollectionLoading } from '@/components/collection-loading';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeading } from '@/components/page-heading';
import { isLiveStatus, StatusBadge, toStatusKey } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { focusRingInset } from '@/components/ui/interaction';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDateTime } from '@/i18n/format';
import { api } from '@/api/client';
import { useWorkflowsQuery, workflowsQueryKey } from '@/api/queries';
import { WorkflowRunHistoryDialog } from '@/features/workflows/run-history-dialog';
import { queryClient } from '@/lib/query-client';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/workflows/')({
  component: WorkflowListPage,
});

type RunHistoryTarget = {
  id: string;
  name: string;
  failed?: boolean;
};

function WorkflowListPage() {
  const { t } = useTranslation(['workflows', 'common']);
  const { locale } = useLocale();
  const navigate = Route.useNavigate();
  const workspaceSlug = "personal";
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState(false);
  const [runHistoryWorkflow, setRunHistoryWorkflow] = useState<RunHistoryTarget | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const { data: all = [], isLoading, isError, refetch } = useWorkflowsQuery(workspaceSlug, { refetchInterval: 5_000 });
  async function importWorkflow(file: File | undefined) {
    if (!file) return;
    setImporting(true);
    try {
      const document = JSON.parse(await file.text()) as Parameters<typeof api.importWorkflow>[1];
      const workflow = await api.importWorkflow(workspaceSlug, document);
      await queryClient.invalidateQueries({ queryKey: workflowsQueryKey() });
      void navigate({ to: '/workflows/$workflowId', params: { workflowId: workflow.id } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('importFailed'));
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = '';
    }
  }

  // Workflows with a live latest Run are pinned first; the sort is stable otherwise.
  const items = useMemo(
    () => all
      .filter((item) => item.name.toLowerCase().includes(search.toLowerCase()))
      .map((item, index) => ({ item, index, live: isLiveStatus(item.lastRunStatus) }))
      .sort((left, right) => Number(right.live) - Number(left.live) || left.index - right.index)
      .map(({ item }) => item),
    [all, search],
  );

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
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
      <PageHeading title={t('title')} />
      <CollectionToolbar className="mt-6" search={search} onSearchChange={setSearch} placeholder={t('search')} />
      <div className="mt-4">
        {isLoading ? <CollectionLoading label={t('loading')} columns={[t('columns.workflow'), t('columns.state'), t('columns.lastRun'), t('columns.updated'), t('columns.actions')]} headerClassName="min-w-[880px] md:grid-cols-[minmax(190px,1.7fr)_minmax(104px,0.8fr)_minmax(140px,1fr)_minmax(144px,0.9fr)_40px]" rowClassName="min-w-[880px] whitespace-nowrap md:grid-cols-[minmax(190px,1.7fr)_minmax(104px,0.8fr)_minmax(140px,1fr)_minmax(144px,0.9fr)_40px]" /> : isError ? <ErrorState title={t('title')} description={t('loadFailed')} onAction={() => void refetch()} /> : all.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : items.length === 0 ? (
          <EmptyState title={t('noMatches.title')} description={t('noMatches.description', { search })} actionLabel={t('common:actions.clearFilters')} onAction={() => setSearch('')} />
        ) : (
          <CollectionTable>
            <CollectionHeader className="min-w-[880px] md:grid-cols-[minmax(190px,1.7fr)_minmax(104px,0.8fr)_minmax(140px,1fr)_minmax(144px,0.9fr)_40px]" columns={[t('columns.workflow'), t('columns.state'), t('columns.lastRun'), t('columns.updated'), t('columns.actions')]} />
            {items.map((item) => {
              const failedRun = item.lastRunStatus === 'failed' || item.lastRunStatus === 'timed_out';
              const lastRunAt = item.lastRunAt ? formatDateTime(item.lastRunAt, locale) : undefined;

              return (
                <CollectionRow key={item.id} className={cn('min-w-[880px] whitespace-nowrap md:grid-cols-[minmax(190px,1.7fr)_minmax(104px,0.8fr)_minmax(140px,1fr)_minmax(144px,0.9fr)_40px]', isLiveStatus(item.lastRunStatus) && 'bg-brand-subtle/40 hover:bg-brand-subtle/70')}>
                  <Link to="/workflows/$workflowId" params={{ workflowId: item.id }} className="min-w-0 truncate text-sm font-medium hover:underline" title={item.name}>{item.name}</Link>
                  <StatusBadge status={item.state} />
	                  <span className="min-w-0" title={lastRunAt}>
	                    {item.lastRunStatus ? (
	                      <button
	                        type="button"
	                        className={cn('cursor-pointer rounded-sm transition-colors duration-[120ms] hover:opacity-90', focusRingInset)}
	                        aria-label={t('latestRunRecordsAction', { name: item.name })}
	                        onClick={() => setRunHistoryWorkflow({ id: item.id, name: item.name, failed: failedRun })}
	                      >
	                        <StatusBadge key={item.lastRunStatus} status={toStatusKey(item.lastRunStatus)} />
	                      </button>
	                    ) : t('common:empty.dash')}
	                  </span>
                  <span className="whitespace-nowrap tabular-nums text-[13px] text-muted-foreground">{formatDateTime(item.updatedAt, locale)}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-compact"
                        aria-label={t('runRecordsAction', { name: item.name })}
                        onClick={() => setRunHistoryWorkflow({ id: item.id, name: item.name })}
                      >
                        <History className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('runRecords')}</TooltipContent>
                  </Tooltip>
                </CollectionRow>
              );
            })}
          </CollectionTable>
        )}
      </div>
      {runHistoryWorkflow ? (
        <WorkflowRunHistoryDialog
          open
          workflowId={runHistoryWorkflow.id}
          workflowName={runHistoryWorkflow.name}
          initialStatus={runHistoryWorkflow.failed ? 'failed' : undefined}
          onOpenChange={(nextOpen) => { if (!nextOpen) setRunHistoryWorkflow(null); }}
        />
      ) : null}
    </div>
  );
}
