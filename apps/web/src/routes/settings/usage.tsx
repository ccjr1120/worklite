import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { ErrorState } from '@/components/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { PageHeading } from '@/components/page-heading';
import { useLocale } from '@/components/locale-provider';
import { formatCurrency, formatNumber, formatTokenCount } from '@/i18n/format';
import { useUsageQuery } from '@/api/queries';

export const Route = createFileRoute('/settings/usage')({
  component: UsageSettingsPage,
});

function UsageSettingsPage() {
  const { t } = useTranslation('settings');
  const { locale } = useLocale();
  const workspaceSlug = "personal";
  const { data: usageRows = [], isLoading, isError, refetch } = useUsageQuery(workspaceSlug);
  const max = Math.max(1, ...usageRows.map((row) => row.tokens));

  return (
    <div className="mx-auto w-full max-w-[840px] px-4 py-6 md:px-6 md:py-8">
      <WorkspaceChrome crumbs={[{ label: t('nav.title') }, { label: t('nav.usage') }]} />
      <PageHeading title={t('usage.title')} />
      {isLoading ? <div className="mt-6 space-y-4" role="status" aria-busy="true" aria-live="polite"><span className="sr-only">{t('usage.loading')}</span>{Array.from({ length: 3 }, (_, index) => <div key={index}><div className="mb-1 flex justify-between gap-4"><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-20" /></div><Skeleton className="h-2 w-full rounded-full" /></div>)}</div> : isError ? <div className="mt-6"><ErrorState title={t('usage.title')} description={t('usage.loadFailed')} onAction={() => void refetch()} /></div> : <div className="mt-6 space-y-3" role="img" aria-label={t('usage.chartLabel')}>
        {usageRows.map((row) => {
          const width = `${Math.round((row.tokens / max) * 100)}%`;
          return (
            <div key={row.model}>
              <div className="mb-1 flex justify-between text-[13px]">
                <span>{row.model}</span>
                <span className="tabular-nums text-muted-foreground" title={formatTokenCount(row.tokens, locale)}>{t('usage.tokens', { count: formatTokenCount(row.tokens, locale) })}</span>
              </div>
              <div className="h-2 rounded-full bg-surface-subtle">
                <div className="h-2 rounded-full bg-brand" style={{ width }} />
              </div>
            </div>
          );
        })}
      </div>}
      <div className="mt-8">
        <CollectionTable>
          <CollectionHeader columns={[t('usage.columns.model'), t('usage.columns.tokens'), t('usage.columns.runs'), t('usage.columns.cost')]} />
          {usageRows.map((row) => (
            <CollectionRow key={row.model}>
              <span className="font-mono text-[13px]">{row.model}</span>
              <span className="tabular-nums text-[13px]" title={formatTokenCount(row.tokens, locale)}>{formatTokenCount(row.tokens, locale)}</span>
              <span className="tabular-nums text-[13px]">{formatNumber(row.runs, locale)}</span>
              <span className="tabular-nums text-[13px]">{formatCurrency(row.cost, locale)}</span>
            </CollectionRow>
          ))}
        </CollectionTable>
      </div>
    </div>
  );
}
