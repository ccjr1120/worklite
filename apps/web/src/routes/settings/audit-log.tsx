import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { EmptyState } from '@/components/empty-state';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { useAuditLogsQuery } from '@/api/queries';

export const Route = createFileRoute('/settings/audit-log')({
  component: AuditLogPage,
});

function AuditLogPage() {
  const { t } = useTranslation(['settings', 'common']);
  const { locale } = useLocale();
  const workspaceSlug = "personal";
  const [search, setSearch] = useState('');
  const { data: auditEvents = [], isLoading, isError } = useAuditLogsQuery(workspaceSlug);
  const items = useMemo(
    () => auditEvents.filter((item) => `${item.actor} ${item.action} ${item.resource}`.toLowerCase().includes(search.toLowerCase())),
    [auditEvents, search],
  );

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
      <WorkspaceChrome crumbs={[{ label: t('nav.title') }, { label: t('nav.auditLog') }]} />
      <h1 className="text-2xl font-semibold tracking-tight">{t('audit.title')}</h1>
      <p className="mt-2 text-[13px] text-muted-foreground">{t('audit.description')}</p>
      <CollectionToolbar className="mt-6" search={search} onSearchChange={setSearch} placeholder={t('audit.search')} />
      <div className="mt-4">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading audit log...</p> : isError ? <p className="text-sm text-danger">Unable to load audit log.</p> : items.length === 0 ? (
          <EmptyState title={t('audit.noMatches.title')} description={t('audit.noMatches.description')} actionLabel={t('common:actions.clearFilters')} onAction={() => setSearch('')} />
        ) : (
          <CollectionTable>
            <CollectionHeader columns={[t('audit.columns.time'), t('audit.columns.actor'), t('audit.columns.action'), t('audit.columns.resource'), t('audit.columns.metadata')]} />
            {items.map((item) => (
              <CollectionRow key={item.id}>
                <span className="tabular-nums text-[13px]">{formatDateTime(item.timestamp, locale)}</span>
                <span className="text-[13px]">{item.actor}</span>
                <span className="text-[13px]">{item.action}</span>
                <span className="truncate text-[13px]">{item.resource}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{item.metadata}</span>
              </CollectionRow>
            ))}
          </CollectionTable>
        )}
      </div>
    </div>
  );
}
