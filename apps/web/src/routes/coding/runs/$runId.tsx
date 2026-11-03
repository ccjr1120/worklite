import { createFileRoute, Link } from '@tanstack/react-router';
import { PageContainer, PageHeading } from '@/components/page-heading';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useTranslation } from 'react-i18next';
import { CodingTeamConversation } from '@/features/coders/coding-team-conversation';

export const Route = createFileRoute('/coding/runs/$runId')({
  component: CoderRunDetailRoute,
});

function CoderRunDetailRoute() {
  const { runId } = Route.useParams();
  const { t } = useTranslation('coders');
  return <PageContainer width="detail"><WorkspaceChrome crumbs={[{ label: 'Coding Team' }, { label: t('run.detail.title') }]} /><PageHeading title={t('run.detail.title')} actions={<Link to="/coding" className="text-sm underline">Coding Team</Link>} /><CodingTeamConversation runId={runId} /></PageContainer>;
}
