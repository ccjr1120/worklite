import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { CopyableId } from '@/components/copyable-id';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeading } from '@/components/page-heading';
import { Skeleton } from '@/components/ui/skeleton';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { api } from '@/api/client';
import { artifactsQueryKey, useArtifactQuery } from '@/api/queries';
import { queryClient } from '@/lib/query-client';
import { toast } from 'sonner';

export const Route = createFileRoute('/artifacts/$artifactId')({
  component: ArtifactDetailsPage,
});

const DOWNLOAD_MEDIA_TYPES: Record<string, string> = {
  json: 'application/json',
  markdown: 'text/markdown',
  text: 'text/plain',
};

const DOWNLOAD_EXTENSIONS: Record<string, string> = {
  json: '.json',
  markdown: '.md',
  text: '.txt',
};

function downloadFileName(name: string, type: string) {
  const extension = DOWNLOAD_EXTENSIONS[type] ?? '';
  return extension && name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
}

function ArtifactDetailsPage() {
  const { t } = useTranslation(['artifacts', 'common']);
  const { locale } = useLocale();
  const { artifactId } = Route.useParams();
  const navigate = useNavigate();
  const workspaceSlug = "personal";
  const { data: artifact, isLoading, isError, refetch } = useArtifactQuery(workspaceSlug, artifactId);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  async function deleteArtifact() {
    if (!artifact || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await api.deleteArtifact(workspaceSlug, artifact.id);
      setDeleteOpen(false);
      toast.success(t('delete.success'));
      await queryClient.invalidateQueries({ queryKey: artifactsQueryKey() });
      await queryClient.invalidateQueries({ queryKey: ['run', artifact.runId] });
      void navigate({ to: '/workflows' });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t('delete.failed'));
    } finally {
      setDeleteBusy(false);
    }
  }

  function downloadArtifact() {
    if (!artifact || artifact.type === 'unsupported') return;
    const mediaType = DOWNLOAD_MEDIA_TYPES[artifact.type] ?? 'text/plain';
    const url = URL.createObjectURL(new Blob([artifact.content], { type: `${mediaType};charset=utf-8` }));
    const link = document.createElement('a');
    link.href = url;
    link.download = downloadFileName(artifact.name, artifact.type);
    document.body.append(link);
    link.click();
    link.remove();
    // Revoking in the same task can cancel the download before the browser reads the blob.
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-6 py-6">
        <WorkspaceChrome crumbs={[{ label: t('title'), to: '/workflows' }]} />
        <div role="status" aria-busy="true" aria-live="polite">
          <span className="sr-only">{t('details.loading')}</span>
          <Skeleton className="h-8 w-64" />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-4 w-32" />)}
          </div>
          <Skeleton className="mt-6 h-64 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-6 py-6">
        <WorkspaceChrome crumbs={[{ label: t('title'), to: '/workflows' }]} />
        <ErrorState title={t('details.loadFailedTitle')} description={t('details.loadFailed')} onAction={() => void refetch()} />
      </div>
    );
  }

  if (!artifact) {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-6 py-6">
        <WorkspaceChrome crumbs={[{ label: t('title'), to: '/workflows' }]} />
        <EmptyState title={t('details.unavailableTitle')} description={t('details.unavailableDescription')} />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-6">
      <WorkspaceChrome
        crumbs={[{ label: artifact.name }]}
        actions={
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="icon-compact" aria-label={t('delete.action', { name: artifact.name })} title={t('delete.action', { name: artifact.name })} onClick={() => { setDeleteError(''); setDeleteOpen(true); }}><Trash2 className="size-4" /></Button>
            {artifact.type === 'unsupported' ? null : <Button size="compact" variant="secondary" onClick={downloadArtifact}>{t('common:actions.download')}</Button>}
          </div>
        }
      />
      <PageHeading title={artifact.name} description={`${artifact.type} · ${artifact.size}`} />
      <div className="mt-4 flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
        <CopyableId value={artifact.id} />
        <span>{artifact.workflowName}</span>
        <span>{artifact.runId ? t('details.run', { value: artifact.runId }) : t('details.noRun')}</span>
        <span className="tabular-nums">{formatDateTime(artifact.createdAt, locale)}</span>
      </div>
      <div className="mt-6 overflow-auto rounded-lg border border-border bg-surface p-4">
        {artifact.type === 'unsupported' ? (
          <p className="text-[13px] text-muted-foreground">{t('details.unsupported')}</p>
        ) : artifact.content === '' ? (
          <p className="text-[13px] text-muted-foreground">{t('details.emptyContent')}</p>
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-[13px]">{artifact.content}</pre>
        )}
      </div>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(nextOpen) => { setDeleteOpen(nextOpen); if (!nextOpen) setDeleteError(''); }}
        title={t('delete.title', { name: artifact.name })}
        description={t('delete.description')}
        confirmLabel={t('delete.action', { name: artifact.name })}
        cancelLabel={t('common:actions.cancel')}
        busyLabel={t('delete.deleting')}
        error={deleteError}
        busy={deleteBusy}
        onConfirm={() => void deleteArtifact()}
      />
    </div>
  );
}
