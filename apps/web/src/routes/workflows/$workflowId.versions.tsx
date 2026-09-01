import { createFileRoute, Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeading } from '@/components/page-heading';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { CopyableId } from '@/components/copyable-id';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { useWorkflowQuery, useWorkflowVersionsQuery } from '@/api/queries';

export const Route = createFileRoute('/workflows/$workflowId/versions')({
  component: WorkflowVersionsPage,
});

function WorkflowVersionsPage() {
  const { t } = useTranslation(['workflows', 'common']);
  const { locale } = useLocale();
  const { workflowId } = Route.useParams();
  const workspaceSlug = "personal";
  const { data: workflow } = useWorkflowQuery(workspaceSlug, workflowId);
  const { data: versions = [] } = useWorkflowVersionsQuery(workspaceSlug, workflowId);

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-6">
      <WorkspaceChrome
        crumbs={[
          { label: t('title'), to: '/workflows' },
          { label: workflow?.name ?? t('editor.fallback'), to: `/workflows/${workflowId}` },
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
                <span className="text-[13px]">{item.publishedBy}</span>
                <span className="tabular-nums text-[13px]">{item.definition.nodes.length}</span>
                <span className="flex items-center gap-3 text-[13px] text-muted-foreground">
                  {t('common:empty.dash')}
                  <ButtonLink workflowId={workflowId} />
                </span>
              </CollectionRow>
            ))}
          </CollectionTable>
        )}
      </div>
    </div>
  );
}

function ButtonLink({ workflowId }: { workflowId: string }) {
  const { t } = useTranslation('common');
  return (
    <Link to="/workflows/$workflowId" params={{ workflowId }} className="text-muted-foreground hover:text-foreground">
      {t('actions.open')}
    </Link>
  );
}
