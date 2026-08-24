import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatCurrency, formatNumber } from '@/i18n/format';
import { usageRows } from '@/mock/data';

export const Route = createFileRoute('/$teamSlug/settings/usage')({
  component: UsageSettingsPage,
});

function UsageSettingsPage() {
  const { t } = useTranslation('settings');
  const { locale } = useLocale();
  const max = Math.max(...usageRows.map((row) => row.tokens));

  return (
    <div className="mx-auto w-full max-w-[840px] px-6 py-6">
      <WorkspaceChrome crumbs={[{ label: t('nav.title') }, { label: t('nav.usage') }]} />
      <h1 className="text-2xl font-semibold tracking-tight">{t('usage.title')}</h1>
      <p className="mt-2 text-[13px] text-muted-foreground">{t('usage.description')}</p>
      <div className="mt-6 space-y-3" role="img" aria-label={t('usage.chartLabel')}>
        {usageRows.map((row) => {
          const width = `${Math.round((row.tokens / max) * 100)}%`;
          return (
            <div key={row.model}>
              <div className="mb-1 flex justify-between text-[13px]">
                <span>{row.model}</span>
                <span className="tabular-nums text-muted-foreground">{t('usage.tokens', { count: formatNumber(row.tokens, locale) })}</span>
              </div>
              <div className="h-2 rounded-full bg-surface-subtle">
                <div className="h-2 rounded-full bg-brand" style={{ width }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-8">
        <CollectionTable>
          <CollectionHeader columns={[t('usage.columns.model'), t('usage.columns.tokens'), t('usage.columns.runs'), t('usage.columns.cost'), t('usage.columns.empty')]} />
          {usageRows.map((row) => (
            <CollectionRow key={row.model}>
              <span className="font-mono text-[13px]">{row.model}</span>
              <span className="tabular-nums text-[13px]">{formatNumber(row.tokens, locale)}</span>
              <span className="tabular-nums text-[13px]">{formatNumber(row.runs, locale)}</span>
              <span className="tabular-nums text-[13px]">{formatCurrency(row.cost, locale)}</span>
              <span />
            </CollectionRow>
          ))}
        </CollectionTable>
      </div>
    </div>
  );
}
