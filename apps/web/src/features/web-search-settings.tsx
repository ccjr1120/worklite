import { useState } from 'react';
import { LoaderCircle, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PasswordInput } from '@/components/password-input';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useLocale } from '@/components/locale-provider';
import { ApiError, api } from '@/api/client';
import { useWebSearchSettingsQuery } from '@/api/queries';
import { queryClient } from '@/lib/query-client';
import { formatDateTime } from '@/i18n/format';

type WebSearchSettingsProps = {
  className?: string;
};

export function WebSearchSettings({ className = 'mt-6' }: WebSearchSettingsProps) {
  const { t } = useTranslation(['settings', 'common']);
  const { locale } = useLocale();
  const settingsQuery = useWebSearchSettingsQuery();
  const settings = settingsQuery.data;
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testQuery, setTestQuery] = useState('WorkLite');
  const [testBusy, setTestBusy] = useState(false);
  const [testError, setTestError] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState('');

  async function saveKey() {
    const key = apiKey.trim();
    if (!key) {
      setError(t('providers.webSearch.keyRequired'));
      return;
    }
    setBusy(true);
    setError('');
    setTestError('');
    setTestResult(null);
    try {
      await api.saveWebSearchKey({ apiKey: key });
      // The secret is write-only. Drop the only UI copy as soon as the server
      // confirms encryption and storage; never include it in a Chat message.
      setApiKey('');
      await queryClient.invalidateQueries({ queryKey: ['web-search-settings'] });
      toast.success(t('providers.webSearch.saved'));
    } catch (caught: unknown) {
      // The API returns only fixed validation/configuration messages here; it
      // never reflects the submitted key.
      setError(caught instanceof ApiError ? caught.message : t('providers.webSearch.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function testSearch() {
    const query = testQuery.trim();
    if (!query) {
      setTestError(t('providers.webSearch.testQueryRequired'));
      setTestResult(null);
      return;
    }
    setTestBusy(true);
    setTestError('');
    setTestResult(null);
    try {
      const result = await api.testWebSearch({ query });
      setTestResult(t('providers.webSearch.testSucceeded', { count: result.resultCount }));
    } catch (caught: unknown) {
      setTestError(caught instanceof Error ? caught.message : t('providers.webSearch.testFailed'));
    } finally {
      setTestBusy(false);
    }
  }

  async function clearKey() {
    setClearBusy(true);
    setClearError('');
    try {
      await api.clearWebSearchKey();
      setApiKey('');
      setTestResult(null);
      setConfirmClear(false);
      await queryClient.invalidateQueries({ queryKey: ['web-search-settings'] });
      toast.success(t('providers.webSearch.cleared'));
    } catch {
      setClearError(t('providers.webSearch.clearFailed'));
    } finally {
      setClearBusy(false);
    }
  }

  return (
    <section className={`${className} w-full rounded-xl border border-border bg-surface p-4 shadow-xs`} aria-labelledby="web-search-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="web-search-title" className="text-base font-semibold">{t('providers.webSearch.title')}</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">{t('providers.webSearch.description')}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-xs font-medium text-muted-foreground">{t('providers.webSearch.status')}</p>
          <p className={`mt-1 text-sm font-medium ${settings?.configured ? 'text-success' : 'text-muted-foreground'}`}>
            {settings ? settings.configured ? t('providers.webSearch.configured') : t('providers.webSearch.notConfigured') : t('providers.webSearch.loading')}
          </p>
          {settings?.updatedAt ? <p className="mt-1 text-xs text-muted-foreground">{t('providers.webSearch.updatedAt')}: {formatDateTime(settings.updatedAt, locale)}</p> : null}
        </div>
      </div>
      {settingsQuery.isError ? <p className="mt-3 text-[13px] text-danger" role="alert">{t('providers.webSearch.loadFailed')}</p> : null}
      <form
        className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void saveKey();
        }}
      >
        <Field label={t('providers.webSearch.apiKey')} htmlFor="web-search-api-key" hint={t('providers.webSearch.hint')} error={error} className="min-w-0 flex-1">
          <PasswordInput
            id="web-search-api-key"
            autoComplete="off"
            spellCheck={false}
            placeholder={settings?.configured ? t('providers.webSearch.replacePlaceholder') : t('providers.webSearch.placeholder')}
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setError('');
            }}
            disabled={busy}
          />
        </Field>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="submit" disabled={busy || !apiKey.trim()}>
            {busy ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
            {t('providers.webSearch.save')}
          </Button>
          <Button type="button" variant="secondary" disabled={busy || !settings?.configured} onClick={() => { setClearError(''); setConfirmClear(true); }}>
            {t('providers.webSearch.clear')}
          </Button>
        </div>
      </form>
      <form
        className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void testSearch();
        }}
      >
        <Field label={t('providers.webSearch.testQuery')} htmlFor="web-search-test-query" hint={t('providers.webSearch.testQueryHint')} error={testError} className="min-w-0 flex-1">
          <Input
            id="web-search-test-query"
            autoComplete="off"
            maxLength={100}
            value={testQuery}
            onChange={(event) => {
              setTestQuery(event.target.value);
              setTestError('');
              setTestResult(null);
            }}
            disabled={testBusy}
          />
        </Field>
        <Button type="submit" variant="secondary" disabled={testBusy || !settings?.configured || !testQuery.trim()}>
          {testBusy ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <Search className="size-4" aria-hidden="true" />}
          {testBusy ? t('providers.webSearch.testRunning') : t('providers.webSearch.test')}
        </Button>
      </form>
      {testResult ? <p className="mt-3 text-[13px] text-success" role="status">{testResult}</p> : null}
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={(nextOpen) => { if (!nextOpen) { setConfirmClear(false); setClearError(''); } }}
        title={t('providers.webSearch.clearTitle')}
        description={t('providers.webSearch.clearDescription')}
        confirmLabel={t('providers.webSearch.clearAction')}
        cancelLabel={t('common:actions.cancel')}
        busyLabel={t('providers.webSearch.clearAction')}
        error={clearError}
        busy={clearBusy}
        onConfirm={() => void clearKey()}
      />
    </section>
  );
}
