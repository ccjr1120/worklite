import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Copy, Download, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError, api } from '@/api/client';
import { artifactsQueryKey, useArtifactQuery } from '@/api/queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { useLocale } from '@/components/locale-provider';
import { PageHeading } from '@/components/page-heading';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { ArtifactReader } from '@/features/artifacts/artifact-reader';
import { formatDateTime } from '@/i18n/format';
import { queryClient } from '@/lib/query-client';

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
  const workspaceSlug = 'personal';
  const { data: artifact, isLoading, isError, error, refetch } = useArtifactQuery(workspaceSlug, artifactId);
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
      queryClient.removeQueries({ queryKey: ['artifact', artifact.id] });
      await queryClient.invalidateQueries({ queryKey: artifactsQueryKey() });
      await queryClient.invalidateQueries({ queryKey: ['run', artifact.runId] });
      void navigate({ to: '/artifacts' });
    } catch (failure) {
      setDeleteError(failure instanceof Error ? failure.message : t('delete.failed'));
    } finally {
      setDeleteBusy(false);
    }
  }

  function downloadArtifact() {
    if (!artifact || artifact.type === 'unsupported') return;
    if (artifact.type === 'image') {
      if (!artifact.contentUrl) return;
      const link = document.createElement('a');
      link.href = `${artifact.contentUrl}?download=true`;
      link.download = `${artifact.name}.png`;
      document.body.append(link);
      link.click();
      link.remove();
      return;
    }
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

  async function copyArtifact() {
    if (!artifact || artifact.type === 'image') return;
    try {
      await navigator.clipboard.writeText(artifact.content);
      toast.success(t('reader.copied'));
    } catch {
      toast.error(t('reader.copyFailed'));
    }
  }

  const backButton = (
    <Button asChild variant="ghost" size="icon-compact" className="md:hidden">
      <Link to="/artifacts" aria-label={t('list.back')}><ArrowLeft className="size-4" /></Link>
    </Button>
  );

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-[900px] px-4 py-6 md:px-8">
        <WorkspaceChrome crumbs={[{ label: t('title'), to: '/artifacts' }]} back={backButton} />
        <div role="status" aria-busy="true" aria-live="polite" className="mt-5">
          <span className="sr-only">{t('details.loading')}</span>
          <Skeleton className="h-6 w-2/3" />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-4 w-28" />)}
          </div>
          <Skeleton className="mt-6 h-72 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  const notFound = isError && error instanceof ApiError && error.status === 404;

  if (notFound || (!isError && !artifact)) {
    return (
      <div className="mx-auto w-full max-w-[900px] px-4 py-6 md:px-8">
        <WorkspaceChrome crumbs={[{ label: t('title'), to: '/artifacts' }]} back={backButton} />
        <div className="mt-6">
          <EmptyState title={t('details.unavailableTitle')} description={t('details.unavailableDescription')} />
        </div>
      </div>
    );
  }

  if (isError || !artifact) {
    return (
      <div className="mx-auto w-full max-w-[900px] px-4 py-6 md:px-8">
        <WorkspaceChrome crumbs={[{ label: t('title'), to: '/artifacts' }]} back={backButton} />
        <div className="mt-6">
          <ErrorState title={t('details.loadFailedTitle')} description={t('details.loadFailed')} onAction={() => void refetch()} />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[900px] px-4 py-6 md:px-8">
      <WorkspaceChrome
        crumbs={[{ label: t('title'), to: '/artifacts' }, { label: artifact.name }]}
        back={backButton}
        actions={
          <div className="flex items-center gap-1.5">
            {artifact.type === 'image' ? null : (
              <Button type="button" variant="ghost" size="compact" onClick={() => void copyArtifact()}>
                <Copy className="size-4" />
                {t('reader.copy')}
              </Button>
            )}
            {artifact.type === 'unsupported' ? null : (
              <Button type="button" variant="ghost" size="icon-compact" aria-label={t('common:actions.download')} onClick={downloadArtifact}>
                <Download className="size-4" />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-compact"
              className="text-danger hover:text-danger"
              aria-label={t('delete.action', { name: artifact.name })}
              onClick={() => { setDeleteError(''); setDeleteOpen(true); }}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        }
      />

      {artifact.type === 'markdown' ? null : <PageHeading className="mt-5" title={artifact.name} />}

      <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-muted-foreground">
        <Badge variant="brand">{artifact.type === 'image' ? t('list.imageType') : artifact.type}</Badge>
        {artifact.workflowId ? (
          <Link to="/workflows/$workflowId" params={{ workflowId: artifact.workflowId }} className="truncate font-medium text-brand-text underline-offset-2 hover:underline">
            {artifact.workflowName}
          </Link>
        ) : (
          <span className="truncate">{artifact.workflowName}</span>
        )}
        {artifact.runId ? (
          <Link to="/runs/$runId" params={{ runId: artifact.runId }} className="font-medium text-brand-text underline-offset-2 hover:underline">
            {t('reader.viewRun')}
          </Link>
        ) : (
          <span>{t('details.noRun')}</span>
        )}
        <span className="tabular-nums">{formatDateTime(artifact.createdAt, locale)}</span>
        <span className="tabular-nums">{artifact.size}</span>
        {artifact.type === 'image'
          ? <span className="tabular-nums">{t('list.dimensions', { width: artifact.width ?? '—', height: artifact.height ?? '—' })}</span>
          : <span className="tabular-nums">{t('list.length', { count: artifact.contentLength })}</span>}
      </div>

      <div className="mt-5">
        <ArtifactReader artifact={artifact} />
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
