import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AgentResourceNav } from '@/components/agent-resource-nav';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useMcpServersQuery } from '@/api/queries';

export const Route = createFileRoute('/mcp-servers/')({
  component: McpListPage,
});

function McpListPage() {
  const { t } = useTranslation(['mcpServers', 'common']);
  const workspaceSlug = "personal";
  const [search, setSearch] = useState('');
  const { data: all = [], isLoading, isError } = useMcpServersQuery(workspaceSlug);
  const items = useMemo(() => all.filter((item) => item.name.toLowerCase().includes(search.toLowerCase())), [all, search]);

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
      <WorkspaceChrome
        crumbs={[{ label: t('title') }]}
      />
      <PageHeading title={t('title')} description={t('description')} />
      <AgentResourceNav active="mcp-servers" />
      <CollectionToolbar
        className="mt-6"
        search={search}
        onSearchChange={setSearch}
        placeholder={t('search')}
        actions={
          <Button asChild size="compact">
            <Link to="/mcp-servers/$serverId" params={{ serverId: 'new' }}>
              <Plus className="size-4" />
              {t('create')}
            </Link>
          </Button>
        }
      />
      <div className="mt-4">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading MCP servers...</p> : isError ? <p className="text-sm text-danger">Unable to load MCP servers.</p> : all.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : items.length === 0 ? (
          <EmptyState title={t('noMatches.title')} description={t('noMatches.description', { search })} actionLabel={t('common:actions.clearFilters')} onAction={() => setSearch('')} />
        ) : (
          <CollectionTable>
            <CollectionHeader columns={[t('columns.server'), t('columns.connection'), t('columns.transport'), t('columns.allowedTools'), t('columns.version')]} />
            {items.map((item) => (
              <Link key={item.id} to="/mcp-servers/$serverId" params={{ serverId: item.id }} className="block">
                <CollectionRow>
                  <span className="font-medium">{item.name}</span>
                  <StatusBadge status={item.connection} />
                  <span className="text-[13px] text-muted-foreground">{item.transport}</span>
                  <span className="tabular-nums text-[13px]">{item.allowedTools}</span>
                  <span className="font-mono text-[13px]">{item.version}</span>
                </CollectionRow>
              </Link>
            ))}
          </CollectionTable>
        )}
      </div>
    </div>
  );
}
