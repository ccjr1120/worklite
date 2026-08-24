import { createFileRoute, Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeading } from '@/components/page-heading';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { CopyableId } from '@/components/copyable-id';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { workflows } from '@/mock/data';

export const Route = createFileRoute('/$teamSlug/workflows/$workflowId/versions')({
  component: WorkflowVersionsPage,
});

function WorkflowVersionsPage() {
  const { t } = useTranslation(['workflows', 'common']);
  const { locale } = useLocale();
  const { teamSlug, workflowId } = Route.useParams();
  const workflow = workflows.find((item) => item.id === workflowId);
  const versions = workflow
    ? [
        { id: 'v8', publishedAt: '2026-08-13 18:02', publisher: 'Alex Chen', steps: 3, lastRun: 'running' as const },
        { id: 'v7', publishedAt: '2026-08-10 07:00', publisher: 'Alex Chen', steps: 3, lastRun: 'completed' as const },
      ]
    : [];

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-6">
      <WorkspaceChrome
        crumbs={[
          { label: t('title'), to: `/${teamSlug}/workflows` },
          { label: workflow?.name ?? t('editor.fallback'), to: `/${teamSlug}/workflows/${workflowId}` },
          { label: t('versions.title') },
        ]}
      />
      <PageHeading title={t('versions.title')} description={t('versions.description')} />
      <div className="mt-6">
        {versions.length === 0 ? (
          <EmptyState title={t('versions.empty.title')} description={t('versions.empty.description')} />
        ) : (
          <CollectionTable>
            <CollectionHeader columns={[t('versions.columns.version'), t('versions.columns.published'), t('versions.columns.publisher'), t('versions.columns.steps'), t('versions.columns.recentRun')]} />
            {versions.map((item) => (
              <CollectionRow key={item.id}>
                <CopyableId value={item.id} />
                <span className="tabular-nums text-[13px]">{formatDateTime(item.publishedAt, locale)}</span>
                <span className="text-[13px]">{item.publisher}</span>
                <span className="tabular-nums text-[13px]">{item.steps}</span>
                <span className="flex items-center gap-3 text-[13px]">
                  {t(`common:status.${item.lastRun}`)}
                  <ButtonLink teamSlug={teamSlug} workflowId={workflowId} />
                </span>
              </CollectionRow>
            ))}
          </CollectionTable>
        )}
      </div>
    </div>
  );
}

function ButtonLink({ teamSlug, workflowId }: { teamSlug: string; workflowId: string }) {
  const { t } = useTranslation('common');
  return (
    <Link to="/$teamSlug/workflows/$workflowId" params={{ teamSlug, workflowId }} className="text-muted-foreground hover:text-foreground">
      {t('actions.open')}
    </Link>
  );
}
