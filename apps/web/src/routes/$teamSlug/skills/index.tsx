import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Plus, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { AgentResourceNav } from '@/components/agent-resource-nav';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { filterByTeam, skills } from '@/mock/data';

export const Route = createFileRoute('/$teamSlug/skills/')({
  component: SkillListPage,
});

function SkillListPage() {
  const { t } = useTranslation(['skills', 'common']);
  const { locale } = useLocale();
  const { teamSlug } = Route.useParams();
  const [search, setSearch] = useState('');
  const all = filterByTeam(skills, teamSlug);
  const items = useMemo(() => all.filter((item) => item.name.toLowerCase().includes(search.toLowerCase())), [all, search]);

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
      <WorkspaceChrome
        crumbs={[{ label: t('title') }]}
        actions={
          <>
            <Button asChild size="compact" variant="secondary">
              <Link to="/$teamSlug/skills/$skillId" params={{ teamSlug, skillId: 'new' }}>
                <Upload className="size-4" />
                {t('upload')}
              </Link>
            </Button>
            <Button asChild size="compact">
              <Link to="/$teamSlug/skills/$skillId" params={{ teamSlug, skillId: 'new' }}>
                <Plus className="size-4" />
                {t('create')}
              </Link>
            </Button>
          </>
        }
      />
      <PageHeading title={t('title')} description={t('description')} />
      <AgentResourceNav teamSlug={teamSlug} active="skills" />
      <CollectionToolbar className="mt-6" search={search} onSearchChange={setSearch} placeholder={t('search')} />
      <div className="mt-4">
        {all.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : items.length === 0 ? (
          <EmptyState title={t('noMatches.title')} description={t('noMatches.description', { search })} actionLabel={t('common:actions.clearFilters')} onAction={() => setSearch('')} />
        ) : (
          <CollectionTable>
            <CollectionHeader columns={[t('columns.skill'), t('columns.source'), t('columns.version'), t('columns.validation'), t('columns.updated')]} />
            {items.map((item) => (
              <Link key={item.id} to="/$teamSlug/skills/$skillId" params={{ teamSlug, skillId: item.id }} className="block">
                <CollectionRow>
                  <span className="font-medium">{item.name}</span>
                  <span className="text-[13px] text-muted-foreground">{t(`source.${item.source}`)}</span>
                  <span className="font-mono text-[13px]">{item.version}</span>
                  <StatusBadge status={item.validation} />
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
