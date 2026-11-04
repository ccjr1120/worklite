import { useState } from 'react';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { useAgentsQuery } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { PageHeading } from '@/components/page-heading';
import { ErrorState } from '@/components/error-state';
import { EmptyState } from '@/components/empty-state';

export const Route = createFileRoute('/agents/')({ component: AgentsPage });

function AgentsPage() {
  const { t } = useTranslation('agents');
  const [search, setSearch] = useState('');
  const query = useAgentsQuery();
  const agents = (query.data ?? []).filter((agent) => agent.kind === 'custom');
  const children = new Set(agents.flatMap((agent) => agent.collaboration?.subAgentIds ?? []));
  const topLevelAgents = agents.filter((agent) => !children.has(agent.id));
  const term = search.trim().toLocaleLowerCase();
  const visible = topLevelAgents.filter((agent) => !term || `${agent.name} ${agent.responsibility ?? ''}`.toLocaleLowerCase().includes(term));
  return <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6">
    <WorkspaceChrome crumbs={[{ label: t('title') }]} actions={<Button asChild size="compact"><Link to="/agents/$agentId" params={{ agentId: 'new' }}><Plus className="size-4" />{t('create')}</Link></Button>} />
    <PageHeading title={t('title')} />
    <CollectionToolbar className="mt-6" search={search} onSearchChange={setSearch} placeholder={t('search')} />
    {query.isError ? <ErrorState title={t('title')} description={t('loadFailed')} onAction={() => void query.refetch()} /> : query.isLoading ? <p className="mt-6 text-sm text-muted-foreground">{t('loading')}</p> : !topLevelAgents.length ? <EmptyState title={t('empty')} description={t('emptyDescription')} /> : !visible.length ? <EmptyState className="mt-6" title={t('noMatches')} description={t('noMatchesDescription')} /> : <ul className="mt-6 divide-y divide-border rounded-xl border border-border bg-surface p-1">{visible.map((agent) => <li key={agent.id}>
      <Link to="/agents/$agentId" params={{ agentId: agent.id }} aria-labelledby={`agent-${agent.id}`} className="block rounded-lg px-4 py-4 transition-colors hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
        <span id={`agent-${agent.id}`} className="block text-sm font-medium">{agent.name}</span>
        <span className="mt-1.5 block whitespace-pre-wrap text-[13px] leading-6 text-muted-foreground">{agent.responsibility?.trim() || t('noResponsibility')}</span>
      </Link>
    </li>)}</ul>}
  </div>;
}
