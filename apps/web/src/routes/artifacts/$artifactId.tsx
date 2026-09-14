import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
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
  const { t } = useTranslation(['artifacts', 'runs', 'common']);
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
      await queryClient.invalidateQueries({ queryKey: ['run', artifact.runId] });
      void navigate({ to: '/runs/$runId', params: { runId: artifact.runId } });
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
          { label: t('runs:title'), to: '/runs' },
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
