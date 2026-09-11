import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Trash2, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CopyableId } from '@/components/copyable-id';
import { PageHeading } from '@/components/page-heading';
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

function ArtifactDetailsPage() {
  const { t } = useTranslation(['artifacts', 'common']);
  const { locale } = useLocale();
  const { artifactId } = Route.useParams();
  const navigate = useNavigate();
  const workspaceSlug = "personal";
  const { data: artifact } = useArtifactQuery(workspaceSlug, artifactId);
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
      void navigate({ to: '/artifacts' });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t('delete.failed'));
    } finally {
      setDeleteBusy(false);
    }
  }

  if (!artifact) {
    return (
      <div className="px-6 py-6">
        <PageHeading title={t('details.unavailableTitle')} description={t('details.unavailableDescription')} />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-6">
      <WorkspaceChrome
        crumbs={[
          { label: t('title'), to: '/artifacts' },
          { label: artifact.name },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="icon-compact" aria-label={t('delete.action', { name: artifact.name })} title={t('delete.action', { name: artifact.name })} onClick={() => { setDeleteError(''); setDeleteOpen(true); }}><Trash2 className="size-4" /></Button>
            <Button size="compact" variant="secondary" onClick={() => toast.success(t('details.downloadStarted'))}>{t('common:actions.download')}</Button>
          </div>
        }
      />
      <PageHeading title={artifact.name} description={`${artifact.type} · ${artifact.size}`} />
      <div className="mt-4 flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
        <CopyableId value={artifact.id} />
        <span>{artifact.workflowName}</span>
        {artifact.runId ? <Link className="hover:text-foreground" to="/runs/$runId" params={{ runId: artifact.runId }}>{artifact.runId}</Link> : <span>{t('details.noRun')}</span>}
        <span className="tabular-nums">{formatDateTime(artifact.createdAt, locale)}</span>
      </div>
      <div className="mt-6 overflow-auto rounded-lg border border-border bg-surface p-4">
        {artifact.type === 'unsupported' ? (
          <p className="text-[13px] text-muted-foreground">{t('details.unsupported')}</p>
        ) : (
          <pre className="whitespace-pre-wrap font-mono text-[13px]">{artifact.content}</pre>
        )}
      </div>
      <Dialog open={deleteOpen} onOpenChange={(open) => { if (!open && !deleteBusy) { setDeleteOpen(false); setDeleteError(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('delete.title', { name: artifact.name })}</DialogTitle>
            <DialogDescription>{t('delete.description')}</DialogDescription>
          </DialogHeader>
          {deleteError ? <p className="text-[13px] text-danger" role="alert">{deleteError}</p> : null}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)} disabled={deleteBusy}>{t('common:actions.cancel')}</Button>
            <Button variant="destructive" onClick={() => void deleteArtifact()} disabled={deleteBusy}>{deleteBusy ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}{deleteBusy ? t('delete.deleting') : t('delete.action', { name: artifact.name })}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
