import { createFileRoute, Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { CopyableId } from '@/components/copyable-id';
import { PageHeading } from '@/components/page-heading';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { useArtifactQuery } from '@/api/queries';
import { toast } from 'sonner';

export const Route = createFileRoute('/artifacts/$artifactId')({
  component: ArtifactDetailsPage,
});

function ArtifactDetailsPage() {
  const { t } = useTranslation(['artifacts', 'common']);
  const { locale } = useLocale();
  const { artifactId } = Route.useParams();
  const workspaceSlug = "personal";
  const { data: artifact } = useArtifactQuery(workspaceSlug, artifactId);

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
          <Button
            size="compact"
            variant="secondary"
            onClick={() => toast.success(t('details.downloadStarted'))}
          >
            {t('common:actions.download')}
          </Button>
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
    </div>
  );
}
