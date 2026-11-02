import { createFileRoute, Link } from '@tanstack/react-router';
import { PageContainer, PageHeading } from '@/components/page-heading';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useTranslation } from 'react-i18next';
import { TeamRunDetail } from '@/features/coders/coder-run-detail';

export const Route = createFileRoute('/coding/runs/$runId')({
  component: CoderRunDetailRoute,
});

function CoderRunDetailRoute() {
  const { runId } = Route.useParams();
  const { t } = useTranslation('coders');
  return <PageContainer width="detail"><WorkspaceChrome crumbs={[{ label: 'Coding' }, { label: t('run.detail.title') }]} /><PageHeading title={t('run.detail.title')} actions={<Link to="/coding" className="text-sm underline">Coding</Link>} /><TeamRunDetail runId={runId} /></PageContainer>;
}
