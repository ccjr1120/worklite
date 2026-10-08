import { createFileRoute, Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { CollectionLoading } from '@/components/collection-loading';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeading } from '@/components/page-heading';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { CopyableId } from '@/components/copyable-id';
import { useLocale } from '@/components/locale-provider';
import { focusRing } from '@/components/ui/interaction';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/i18n/format';
import { useWorkflowQuery, useWorkflowVersionsQuery } from '@/api/queries';

export const Route = createFileRoute('/workflows/$workflowId/versions')({
  component: WorkflowVersionsPage,
});

const VERSION_COLUMNS_CLASS = 'grid-cols-[1.4fr_1fr_1fr_0.6fr_0.6fr]';

function WorkflowVersionsPage() {
  const { t } = useTranslation(['workflows', 'common']);
  const { locale } = useLocale();
  const { workflowId } = Route.useParams();
  const workspaceSlug = "personal";
  const { data: workflow, isLoading: workflowLoading } = useWorkflowQuery(workspaceSlug, workflowId);
  const { data: versions = [], isLoading, isError, refetch } = useWorkflowVersionsQuery(workspaceSlug, workflowId);
  const columns = [t('versions.columns.version'), t('versions.columns.published'), t('versions.columns.publisher'), t('versions.columns.steps'), t('versions.columns.actions')];

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6 md:py-8">
      <WorkspaceChrome
        crumbs={[
          { label: t('title'), to: '/workflows' },
          ...(workflowLoading && !workflow ? [] : [{ label: workflow?.name ?? t('editor.fallback'), to: `/workflows/${workflowId}` }]),
          { label: t('versions.title') },
        ]}
      />
      <PageHeading title={t('versions.title')} description={t('versions.description')} />
      <div className="mt-6">
        {isLoading ? (
          <CollectionLoading label={t('versions.loading')} columns={columns} headerClassName={VERSION_COLUMNS_CLASS} rowClassName={VERSION_COLUMNS_CLASS} />
        ) : isError ? (
          <ErrorState title={t('versions.title')} description={t('versions.loadFailed')} onAction={() => void refetch()} />
        ) : versions.length === 0 ? (
          <EmptyState title={t('versions.empty.title')} description={t('versions.empty.description')} />
        ) : (
          <CollectionTable>
            <CollectionHeader className={VERSION_COLUMNS_CLASS} columns={columns} />
            {versions.map((item) => (
              <CollectionRow key={item.id} className={VERSION_COLUMNS_CLASS}>
                <CopyableId value={item.id} />
                <span className="tabular-nums text-[13px]">{formatDateTime(item.publishedAt, locale)}</span>
                <span className="truncate text-[13px]" title={item.publishedBy}>{item.publishedBy}</span>
                <span className="tabular-nums text-[13px]">{item.definition.nodes.length}</span>
                <OpenEditorLink workflowId={workflowId} />
              </CollectionRow>
            ))}
          </CollectionTable>
        )}
      </div>
    </div>
  );
}

function OpenEditorLink({ workflowId }: { workflowId: string }) {
  const { t } = useTranslation('common');
  return (
    <Link
      to="/workflows/$workflowId"
      params={{ workflowId }}
      className={cn('justify-self-start rounded-md px-1.5 py-0.5 text-[13px] text-muted-foreground transition-colors duration-[120ms] ease-out hover:text-foreground', focusRing)}
    >
      {t('actions.open')}
    </Link>
  );
}
