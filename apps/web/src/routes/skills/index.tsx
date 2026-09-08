import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AgentResourceNav } from '@/components/agent-resource-nav';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeading } from '@/components/page-heading';
import { Button } from '@/components/ui/button';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { useSkillsQuery } from '@/api/queries';

export const Route = createFileRoute('/skills/')({
  component: SkillListPage,
});

function SkillListPage() {
  const { t } = useTranslation(['skills', 'common']);
  const { locale } = useLocale();
  const workspaceSlug = "personal";
  const [search, setSearch] = useState('');
  const { data: all = [], isLoading, isError } = useSkillsQuery(workspaceSlug);
  const items = useMemo(() => all.filter((item) => item.id !== 'sk_worklite_platform' && item.name.toLowerCase().includes(search.toLowerCase())), [all, search]);

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
      <WorkspaceChrome
        crumbs={[{ label: t('title') }]}
      />
      <PageHeading title={t('title')} description={t('description')} />
      <AgentResourceNav active="skills" />
      <CollectionToolbar
        className="mt-6"
        search={search}
        onSearchChange={setSearch}
        placeholder={t('search')}
        actions={
          <Button asChild size="compact">
            <Link to="/skills/$skillId" params={{ skillId: 'new' }}>
              <Plus className="size-4" />
              {t('create')}
            </Link>
          </Button>
        }
      />
      <div className="mt-4">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading skills...</p> : isError ? <p className="text-sm text-danger">Unable to load skills.</p> : all.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : items.length === 0 ? (
          <EmptyState title={t('noMatches.title')} description={t('noMatches.description', { search })} actionLabel={t('common:actions.clearFilters')} onAction={() => setSearch('')} />
        ) : (
          <CollectionTable>
            <CollectionHeader className="min-w-[640px] grid-cols-[2fr_1fr_1fr_1fr]" columns={[t('columns.skill'), t('columns.source'), t('columns.version'), t('columns.updated')]} />
            {items.map((item) => (
              <Link key={item.id} to="/skills/$skillId" params={{ skillId: item.id }} className="block">
                <CollectionRow className="min-w-[640px] grid-cols-[2fr_1fr_1fr_1fr]">
                  <span className="flex min-w-0 items-center gap-2 font-medium">
                    <span className="truncate">{item.name}</span>
                  </span>
                  <span className="text-[13px] text-muted-foreground">{t(`source.${item.source}`)}</span>
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
