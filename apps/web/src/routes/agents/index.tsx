import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Blocks, Plus, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AgentMark } from '@/components/agent-mark';
import { AgentResourceNav } from '@/components/agent-resource-nav';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeading } from '@/components/page-heading';
import { Button } from '@/components/ui/button';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime, formatList } from '@/i18n/format';
import { useAgentsQuery } from '@/api/queries';

export const Route = createFileRoute('/agents/')({
  component: AgentListPage,
});

function AgentListPage() {
  const { t } = useTranslation(['agents', 'common']);
  const { locale } = useLocale();
  const workspaceSlug = "personal";
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const { data: all = [], isLoading, isError } = useAgentsQuery(workspaceSlug);
  const items = useMemo(() => {
    return all.filter((item) => item.kind === 'custom').filter((item) =>
      `${item.name} ${item.responsibility} ${item.model} ${item.providerName ?? ''} ${item.skills.map((skill) => skill.name).join(' ')} ${item.mcpServers.map((server) => server.name).join(' ')}`.toLowerCase().includes(search.toLowerCase()),
    );
  }, [all, search]);

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
      <WorkspaceChrome
        crumbs={[{ label: t('title') }]}
      />
      <PageHeading title={t('title')} description={t('description')} />
      <AgentResourceNav active="agents" />
      <CollectionToolbar
        className="mt-6"
        search={search}
        onSearchChange={setSearch}
        placeholder={t('search')}
        actions={
          <Button asChild size="compact">
            <Link to="/agents/$agentId" params={{ agentId: 'new' }}>
              <Plus className="size-4" />
              {t('create')}
            </Link>
          </Button>
        }
      />
      <div className="mt-4">
        {isLoading ? <p className="text-sm text-muted-foreground">{t('loading')}</p> : isError ? <p className="text-sm text-danger">{t('loadFailed')}</p> : all.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} actionLabel={t('create')} onAction={() => void navigate({ to: '/agents/$agentId', params: { agentId: 'new' } })} />
        ) : items.length === 0 ? (
          <EmptyState title={t('noMatches.title')} description={t('noMatches.description', { search })} actionLabel={t('common:actions.clearFilters')} onAction={() => setSearch('')} />
        ) : (
          <CollectionTable>
            <CollectionHeader className="grid-cols-[2fr_1.25fr_1.5fr_1fr]" columns={[t('columns.agent'), t('columns.model'), t('columns.resources'), t('columns.updated')]} />
            {items.map((item) => (
              <Link key={item.id} to="/agents/$agentId" params={{ agentId: item.id }} className="block">
                <CollectionRow className="grid-cols-[2fr_1.25fr_1.5fr_1fr]">
                  <span className="flex min-w-0 items-center gap-3">
                    <AgentMark initials={item.initials} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{item.name}</span>
                      </span>
                      <span className="block truncate text-[13px] text-muted-foreground">{item.responsibility}</span>
                    </span>
                  </span>
                  <span className="text-[13px]">{[item.providerName, item.model].filter(Boolean).join(' / ') || t('notConfigured')}</span>
                  <span className="min-w-0 space-y-1 text-[13px] text-muted-foreground">
                    <span className="flex min-w-0 items-center gap-2"><Blocks className="size-3.5 shrink-0" aria-hidden="true" /><span className="truncate"><span className="sr-only">{t('editor.skills')}: </span>{formatList(item.skills.map((skill) => skill.name), locale) || t('common:empty.dash')}</span></span>
                    <span className="flex min-w-0 items-center gap-2"><Server className="size-3.5 shrink-0" aria-hidden="true" /><span className="truncate"><span className="sr-only">{t('editor.mcpServers')}: </span>{formatList(item.mcpServers.map((server) => server.name), locale) || t('common:empty.dash')}</span></span>
                  </span>
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
