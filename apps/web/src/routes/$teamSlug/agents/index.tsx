import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AgentMark } from '@/components/agent-mark';
import { AgentResourceNav } from '@/components/agent-resource-nav';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime, formatList } from '@/i18n/format';
import { agents, filterByTeam } from '@/mock/data';

export const Route = createFileRoute('/$teamSlug/agents/')({
  component: AgentListPage,
});

function AgentListPage() {
  const { t } = useTranslation(['agents', 'common']);
  const { locale } = useLocale();
  const { teamSlug } = Route.useParams();
  const [search, setSearch] = useState('');
  const items = useMemo(() => {
    return filterByTeam(agents, teamSlug).filter((item) =>
      `${item.name} ${item.responsibility} ${item.model}`.toLowerCase().includes(search.toLowerCase()),
    );
  }, [search, teamSlug]);
  const all = filterByTeam(agents, teamSlug);

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
      <WorkspaceChrome
        crumbs={[{ label: t('title') }]}
        actions={
          <Button asChild size="compact">
            <Link to="/$teamSlug/agents/$agentId" params={{ teamSlug, agentId: 'new' }}>
              <Plus className="size-4" />
              {t('create')}
            </Link>
          </Button>
        }
      />
      <PageHeading title={t('title')} description={t('description')} />
      <AgentResourceNav teamSlug={teamSlug} active="agents" />
      <CollectionToolbar className="mt-6" search={search} onSearchChange={setSearch} placeholder={t('search')} />
      <div className="mt-4">
        {all.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} actionLabel={t('create')} onAction={() => undefined} />
        ) : items.length === 0 ? (
          <EmptyState title={t('noMatches.title')} description={t('noMatches.description', { search })} actionLabel={t('common:actions.clearFilters')} onAction={() => setSearch('')} />
        ) : (
          <CollectionTable>
            <CollectionHeader columns={[t('columns.agent'), t('columns.model'), t('columns.skills'), t('columns.version'), t('columns.updated')]} />
            {items.map((item) => (
              <Link key={item.id} to="/$teamSlug/agents/$agentId" params={{ teamSlug, agentId: item.id }} className="block">
                <CollectionRow>
                  <span className="flex min-w-0 items-center gap-3">
                    <AgentMark initials={item.initials} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{item.name}</span>
                        <StatusBadge status={item.status} />
                      </span>
                      <span className="block truncate text-[13px] text-muted-foreground">{item.responsibility}</span>
                    </span>
                  </span>
                  <span className="font-mono text-[13px]">{item.model}</span>
                  <span className="truncate text-[13px] text-muted-foreground">{formatList(item.skills, locale) || t('common:empty.dash')}</span>
                  <span className="font-mono text-[13px]">{item.version}</span>
                  <span className="tabular-nums text-[13px] text-muted-foreground">{formatDateTime(item.updatedAt, locale)}</span>
                </CollectionRow>
              </Link>
            ))}
          </CollectionTable>
        )}
      </div>
    </div>
  );
}
