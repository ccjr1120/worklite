import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { BarChart3, Bot, ChevronDown, Copy, KeyRound, LoaderCircle, LogIn, Pencil, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { CodexAccountUsageSnapshot, CodexAuthStatus, CodexRateLimitWindow, DiscoverModelProviderRequest, ModelProviderProtocol, ModelProviderTestResult, ModelProviderView, PortkeyGatewayStats, PortkeyGatewayStatus } from '@worklite/contracts';
import { CollectionTable, CollectionHeader, CollectionRow } from '@/components/collection-table';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { EmptyState } from '@/components/empty-state';
import { PageHeading } from '@/components/page-heading';
import { Field } from '@/components/ui/field';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/password-input';
import { StatusBadge } from '@/components/status-badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useCodexAccountUsagesQuery, useCodexAuthQuery, useModelProvidersQuery, usePortkeyGatewayQuery } from '@/api/queries';
import { usePortkeyGatewayStatsQuery } from '@/api/queries';
import { api } from '@/api/client';
import { queryClient } from '@/lib/query-client';
import { formatDateTime, formatList, formatNumber } from '@/i18n/format';
import { useLocale } from '@/components/locale-provider';
import type { AppLocale } from '@/i18n/locale';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const MODEL_PROVIDER_TABS = ['providers', 'codex', 'statistics'] as const;
type ModelProviderTab = (typeof MODEL_PROVIDER_TABS)[number];
type ModelProvidersSearch = { tab: ModelProviderTab };

function isModelProviderTab(value: unknown): value is ModelProviderTab {
  return typeof value === 'string' && MODEL_PROVIDER_TABS.includes(value as ModelProviderTab);
}

export const Route = createFileRoute('/model-providers')({
  validateSearch: (search: Record<string, unknown>): ModelProvidersSearch => ({
    tab: isModelProviderTab(search.tab) ? search.tab : 'providers',
  }),
  component: ModelProvidersPage,
});

type ProviderDialog =
  | { mode: 'create' }
  | { mode: 'edit'; provider: ModelProviderView };

type ProviderTestDialog =
  | { provider: ModelProviderView; model: string; status: 'idle' }
  | { provider: ModelProviderView; model: string; status: 'loading'; startedAt: number; elapsedSeconds: number }
  | { provider: ModelProviderView; model: string; status: 'success'; result: ModelProviderTestResult; elapsedSeconds: number }
  | { provider: ModelProviderView; model: string; status: 'error'; message: string; traceId?: string; elapsedSeconds: number };

const PROVIDER_TEST_PROMPT = '\u4f60\u597d';
const PROVIDER_TEST_MODEL_KEY = 'worklite.provider-test-model.';

function parseHeaders(value: string): Record<string, string> | undefined {
  if (!value.trim()) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((item) => typeof item !== 'string')) throw new Error('invalid');
  const headers = Object.fromEntries(Object.entries(parsed).map(([headerName, headerValue]) => [headerName.trim(), headerValue])) as Record<string, string>;
  if (Object.keys(headers).some((headerName) => !headerName)) throw new Error('invalid');
  return headers;
}

type ModelTokenInputProps = {
  id: string;
  value: string[];
  onChange: (value: string[]) => void;
  placeholder: string;
  removeLabel: (model: string) => string;
  disabled?: boolean;
};

function ModelTokenInput({ id, value, onChange, placeholder, removeLabel, disabled = false }: ModelTokenInputProps) {
  const [draft, setDraft] = useState('');
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function focusInput(position?: number) {
    inputRef.current?.focus();
    if (position !== undefined) window.requestAnimationFrame(() => inputRef.current?.setSelectionRange(position, position));
  }

  function removeAt(index: number) {
    onChange(value.filter((_, itemIndex) => itemIndex !== index));
    setActiveIndex(null);
    focusInput();
  }

  function commit() {
    const model = draft.trim();
    if (!model) return;
    if (!value.includes(model)) onChange([...value, model]);
    setDraft('');
    setActiveIndex(null);
    focusInput();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
      return;
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && activeIndex !== null) {
      event.preventDefault();
      removeAt(activeIndex);
      return;
    }
    if (event.key === 'ArrowLeft' && activeIndex === null && !draft && event.currentTarget.selectionStart === 0 && value.length > 0) {
      event.preventDefault();
      setActiveIndex(value.length - 1);
      return;
    }
    if (event.key === 'ArrowLeft' && activeIndex !== null) {
      event.preventDefault();
      if (activeIndex === 0) {
        setActiveIndex(null);
        focusInput(0);
      } else setActiveIndex(activeIndex - 1);
      return;
    }
    if (event.key === 'ArrowRight' && activeIndex !== null) {
      event.preventDefault();
      if (activeIndex === value.length - 1) {
        setActiveIndex(null);
        focusInput();
      } else setActiveIndex(activeIndex + 1);
      return;
    }
    if (event.key === 'Backspace' && !draft && activeIndex === null && value.length > 0) {
      event.preventDefault();
      removeAt(value.length - 1);
      return;
    }
    if (event.key === 'Delete' && !draft && activeIndex === null && value.length > 0 && event.currentTarget.selectionStart === 0) {
      event.preventDefault();
      removeAt(0);
    }
  }

  return (
    <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
      {value.map((model, index) => (
        <span key={model} className={`inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium ${activeIndex === index ? 'border-brand bg-brand-subtle text-brand' : 'border-border bg-surface-subtle text-foreground'}`}>
          <span className="max-w-[min(22rem,70vw)] truncate font-mono">{model}</span>
          <button type="button" className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40" aria-label={removeLabel(model)} onClick={() => removeAt(index)} disabled={disabled}>
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        className="min-w-[12rem] flex-1 bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
        value={draft}
        placeholder={value.length === 0 ? placeholder : ''}
        disabled={disabled}
        onChange={(event) => { setDraft(event.target.value); setActiveIndex(null); }}
        onKeyDown={handleKeyDown}
        onFocus={() => setActiveIndex(null)}
        onBlur={commit}
      />
    </div>
  );
}

function ModelProvidersPage() {
  const { t } = useTranslation(['settings', 'common']);
  const { locale } = useLocale();
  const workspaceSlug = 'personal';
  const { tab: view } = Route.useSearch();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [testDialog, setTestDialog] = useState<ProviderTestDialog | null>(null);
  const [dialog, setDialog] = useState<ProviderDialog | null>(null);
  const [deleteProvider, setDeleteProvider] = useState<ModelProviderView | null>(null);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [protocol, setProtocol] = useState<ModelProviderProtocol>('openai/chat');
  const [baseURL, setBaseURL] = useState('');
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [headersError, setHeadersError] = useState('');
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [statsWindow, setStatsWindow] = useState<'24h' | '7d' | '30d'>('24h');
  const { data: modelProviders = [], isLoading, isError } = useModelProvidersQuery(workspaceSlug);
  const gatewayQuery = usePortkeyGatewayQuery();
  const codexAuthQuery = useCodexAuthQuery();
  const codexUsageQuery = useCodexAccountUsagesQuery(view === 'codex');
  const [codexAuthBusy, setCodexAuthBusy] = useState(false);
  const codexImportRef = useRef<HTMLInputElement>(null);
  const statsQuery = usePortkeyGatewayStatsQuery(statsWindow);
  const items = useMemo(
    () => modelProviders.filter((provider) => `${provider.name} ${provider.models.join(' ')}`.toLowerCase().includes(search.toLowerCase())),
    [modelProviders, search],
  );

  const codexAccountState = codexAuthQuery.data?.accounts.map((account) => `${account.id}:${account.enabled}`).join('|') ?? '';

  function changeView(value: string) {
    if (!isModelProviderTab(value)) return;
    void navigate({ to: '/model-providers', search: { tab: value } });
  }

  useEffect(() => {
    if (codexAuthQuery.data?.status === 'connected' || codexAuthQuery.data?.status === 'disconnected' || codexAuthQuery.data?.status === 'error') {
      void queryClient.invalidateQueries({ queryKey: ['model-providers'] }).catch(() => undefined);
      void queryClient.invalidateQueries({ queryKey: ['codex-account-usages'] }).catch(() => undefined);
    }
  }, [codexAuthQuery.data?.status, codexAccountState]);

  async function startCodexAuth() {
    setCodexAuthBusy(true);
    const popup = window.open('about:blank', 'worklite-codex-login', 'popup,width=520,height=720');
    try {
      const result = await api.startCodexLogin();
      if (popup) popup.location.href = result.authorizationUrl;
      else window.location.assign(result.authorizationUrl);
      toast.success(t('providers.gateway.codex.loginStarted'));
    } catch (error) {
      popup?.close();
      toast.error(error instanceof Error ? error.message : t('providers.gateway.codex.loginFailed'));
    } finally {
      setCodexAuthBusy(false);
    }
  }

  async function importCodexAccounts(file: File) {
    setCodexAuthBusy(true);
    try {
      const document: unknown = JSON.parse(await file.text());
      await api.importCodexAccounts(document);
      await codexAuthQuery.refetch();
      await codexUsageQuery.refetch();
      await queryClient.invalidateQueries({ queryKey: ['model-providers'] });
      toast.success(t('providers.gateway.codex.imported'));
    } catch (error) { toast.error(error instanceof Error ? error.message : t('providers.gateway.codex.importFailed')); }
    finally { setCodexAuthBusy(false); if (codexImportRef.current) codexImportRef.current.value = ''; }
  }

  async function setCodexAccountEnabled(accountId: string, enabled: boolean) {
    setCodexAuthBusy(true);
    try { await api.updateCodexAccount(accountId, enabled); await codexAuthQuery.refetch(); await codexUsageQuery.refetch(); await queryClient.invalidateQueries({ queryKey: ['model-providers'] }); }
    catch (error) { toast.error(error instanceof Error ? error.message : t('providers.gateway.codex.updateFailed')); }
    finally { setCodexAuthBusy(false); }
  }

  async function refreshCodexAccount(accountId: string) {
    setCodexAuthBusy(true);
    try { await api.refreshCodexAccount(accountId); await codexAuthQuery.refetch(); await codexUsageQuery.refetch(); toast.success(t('providers.gateway.codex.refreshed')); }
    catch (error) { toast.error(error instanceof Error ? error.message : t('providers.gateway.codex.refreshFailed')); }
    finally { setCodexAuthBusy(false); }
  }

  async function deleteCodexAccount(accountId: string) {
    setCodexAuthBusy(true);
    try { await api.deleteCodexAccount(accountId); await codexAuthQuery.refetch(); await codexUsageQuery.refetch(); await queryClient.invalidateQueries({ queryKey: ['model-providers'] }); toast.success(t('providers.gateway.codex.removed')); }
    catch (error) { toast.error(error instanceof Error ? error.message : t('providers.gateway.codex.removeFailed')); }
    finally { setCodexAuthBusy(false); }
  }

  async function refreshCodexUsages() {
    setCodexAuthBusy(true);
    try { await codexUsageQuery.refetch(); toast.success(t('providers.gateway.codex.quotasRefreshed')); }
    catch (error) { toast.error(error instanceof Error ? error.message : t('providers.gateway.codex.quotasRefreshFailed')); }
    finally { setCodexAuthBusy(false); }
  }

  useEffect(() => {
    if (testDialog?.status !== 'loading') return;
    const interval = window.setInterval(() => {
      setTestDialog((current) => current?.status === 'loading' ? { ...current, elapsedSeconds: Math.floor((Date.now() - current.startedAt) / 1_000) } : current);
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [testDialog?.status, testDialog?.provider.id]);

  function openCreate() {
    setName('');
    setApiKey('');
    setProtocol('openai/chat');
    setBaseURL('');
    setModelIds([]);
    setModelsError('');
    setHeadersText('');
    setHeadersError('');
    setProviderError('');
    setDialog({ mode: 'create' });
  }

  function openEdit(provider: ModelProviderView) {
    setName(provider.name);
    setApiKey('');
    setProtocol(provider.protocol);
    setBaseURL(provider.baseURL ?? '');
    setModelIds(provider.models);
    setModelsError('');
    setHeadersText('');
    setHeadersError('');
    setProviderError('');
    setDialog({ mode: 'edit', provider });
  }

  function closeProviderDialog() {
    setDialog(null);
    setApiKey('');
    setModelsError('');
    setHeadersError('');
    setProviderError('');
  }

  async function saveProvider() {
    if (!dialog || (dialog.mode === 'create' && !name.trim())) return;
    if (!baseURL.trim()) {
      setProviderError(t('providers.baseURLRequired'));
      return;
    }
    let headers: Record<string, string> | undefined;
    try {
      headers = parseHeaders(headersText);
    } catch {
      setHeadersError(t('providers.headersError'));
      return;
    }
    const mode = dialog.mode;
    setProviderBusy(true);
    setProviderError('');
    try {
      if (dialog.mode === 'create') {
        await api.saveModelProvider(workspaceSlug, { name: name.trim(), protocol, apiKey: apiKey.trim() || undefined, baseURL: baseURL.trim() || undefined, models: modelIds, ...(headers !== undefined ? { headers } : {}) });
      } else {
        await api.updateModelProvider(workspaceSlug, dialog.provider.id, { name: name.trim(), protocol, apiKey: apiKey.trim() || undefined, baseURL: baseURL.trim() || undefined, models: modelIds, ...(headers !== undefined ? { headers } : {}) });
      }
      closeProviderDialog();
      toast.success(t(mode === 'create' ? 'providers.created' : 'providers.saved'));
      void queryClient.invalidateQueries({ queryKey: ['model-providers'] }).catch(() => undefined);
    } catch (error: unknown) {
      setProviderError(error instanceof Error ? error.message : t('providers.testFailed'));
    } finally {
      setProviderBusy(false);
    }
  }

  async function discoverModels() {
    if (protocol !== 'codex/responses' && !apiKey.trim()) {
      setModelsError(t('providers.modelsApiKeyRequired'));
      return;
    }
    if (!baseURL.trim()) {
      setProviderError(t('providers.baseURLRequired'));
      return;
    }
    let headers: Record<string, string> | undefined;
    try {
      headers = parseHeaders(headersText);
    } catch {
      setHeadersError(t('providers.headersError'));
      return;
    }
    setModelsBusy(true);
    setModelsError('');
    try {
      const input: DiscoverModelProviderRequest = { protocol, apiKey: apiKey.trim(), baseURL: baseURL.trim() || undefined, ...(headers !== undefined ? { headers } : {}) };
      const result = await api.discoverModelProviderModels(input);
      setModelIds((current) => [...new Set([...current, ...result.models])]);
      toast.success(t('providers.modelsFetched', { count: result.models.length }));
    } catch (error: unknown) {
      setModelsError(error instanceof Error ? error.message : t('providers.modelsFetchFailed'));
    } finally {
      setModelsBusy(false);
    }
  }

  async function removeProvider() {
    if (!deleteProvider) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await api.deleteModelProvider(workspaceSlug, deleteProvider.id);
      setDeleteProvider(null);
      toast.success(t('providers.deleted'));
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['model-providers'] }),
        queryClient.invalidateQueries({ queryKey: ['agents'] }),
        queryClient.invalidateQueries({ queryKey: ['agent', 'agt_system_helper_chat'] }),
      ]).catch(() => undefined);
    } catch (error: unknown) {
      setDeleteError(error instanceof Error ? error.message : t('providers.deleteFailed'));
    } finally {
      setDeleteBusy(false);
    }
  }

  function openProviderTest(provider: ModelProviderView) {
    const remembered = window.localStorage.getItem(`${PROVIDER_TEST_MODEL_KEY}${provider.id}`);
    const model = remembered && provider.models.includes(remembered) ? remembered : provider.models[0] ?? '';
    setTestDialog({ provider, model, status: 'idle' });
  }

  function selectTestModel(model: string) {
    setTestDialog((current) => current ? { provider: current.provider, model, status: 'idle' } : current);
    if (testDialog) window.localStorage.setItem(`${PROVIDER_TEST_MODEL_KEY}${testDialog.provider.id}`, model);
  }

  function runProviderTest() {
    if (!testDialog || !testDialog.model || testDialog.status === 'loading') return;
    const { provider, model } = testDialog;
    window.localStorage.setItem(`${PROVIDER_TEST_MODEL_KEY}${provider.id}`, model);
    const startedAt = currentTime();
    setTestDialog({ provider, model, status: 'loading', startedAt, elapsedSeconds: 0 });
    void api.testModelProvider(workspaceSlug, provider.id, { model }).then((result) => {
      setTestDialog((current) => current?.provider.id === provider.id ? { provider, model, status: 'success', result, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1_000) } : current);
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : t('providers.testFailed');
      const traceId = error instanceof Error && 'traceId' in error && typeof error.traceId === 'string' ? error.traceId : undefined;
      setTestDialog((current) => current?.provider.id === provider.id ? { provider, model, status: 'error', message, traceId, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1_000) } : current);
    });
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
      <WorkspaceChrome crumbs={[{ label: t('providers.title') }]} />
      <PageHeading title={t('providers.title')} description={t('providers.description')} />
      <Tabs value={view} onValueChange={changeView} className="mt-6">
        <TabsList aria-label={t('providers.views.label')}>
          <TabsTrigger value="providers">{t('providers.views.providers')}</TabsTrigger>
          <TabsTrigger value="codex">{t('providers.views.codex')}</TabsTrigger>
          <TabsTrigger value="statistics"><BarChart3 className="size-4" />{t('providers.views.statistics')}</TabsTrigger>
        </TabsList>
        <TabsContent value="providers">
      <GatewayPanel
        gateway={gatewayQuery.data}
        providers={modelProviders}
        auth={codexAuthQuery.data}
        t={(key) => t(key as never)}
      />
      <section aria-labelledby="model-providers-section-title">
        <div className="flex items-center justify-between gap-4">
          <h2 id="model-providers-section-title" className="text-base font-semibold">{t('providers.views.providers')}</h2>
        </div>
        <CollectionToolbar
          className="mt-4"
          search={search}
          onSearchChange={setSearch}
          placeholder={t('providers.search')}
          actions={
            <Button size="compact" onClick={openCreate}>
              <Plus className="size-4" />
              {t('providers.create')}
            </Button>
          }
        />
        <div className="mt-4">
          {isLoading ? <p className="text-sm text-muted-foreground">Loading providers...</p> : isError ? <p className="text-sm text-danger">Unable to load providers.</p> : modelProviders.length === 0 ? (
            <EmptyState title={t('providers.empty.title')} description={t('providers.empty.description')} actionLabel={t('providers.create')} onAction={openCreate} />
          ) : items.length === 0 ? (
            <EmptyState title={t('providers.noMatches.title')} description={t('providers.noMatches.description')} actionLabel={t('common:actions.clearFilters')} onAction={() => setSearch('')} />
          ) : (
            <CollectionTable>
              <CollectionHeader className="min-w-[900px] [&>span]:whitespace-nowrap" columns={[t('providers.columns.provider'), t('providers.columns.status'), t('providers.columns.models'), t('providers.columns.credential'), t('providers.columns.actions')]} />
              {items.map((provider) => (
                <CollectionRow key={provider.id} className="min-w-[900px] [&>span]:whitespace-nowrap">
                  <span className="flex min-w-0 items-center gap-2 font-medium"><KeyRound className="size-4 shrink-0 text-brand" aria-hidden="true" /><span className="min-w-0 truncate"><span className="block truncate">{provider.name}</span><span className="block text-xs font-normal text-muted-foreground">{provider.protocol}</span></span></span>
                  <StatusBadge status={provider.status} />
                  <span className="truncate text-[13px] text-muted-foreground">{formatList(provider.models, locale) || t('common:empty.dash')}</span>
                  <span className="min-w-0 text-[13px] text-muted-foreground"><span className="block font-mono">{provider.maskedKey || t('common:empty.dash')}</span>{provider.headerNames.length ? <span className="block truncate">{t('providers.headerNames', { names: provider.headerNames.join(', ') })}</span> : null}</span>
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="secondary" size="compact" onClick={() => openProviderTest(provider)} disabled={testDialog?.status === 'loading' && testDialog.provider.id === provider.id}>
                      {testDialog?.status === 'loading' && testDialog.provider.id === provider.id ? t('providers.testing') : t('providers.test')}
                    </Button>
                    {provider.name === 'codex' && provider.protocol === 'codex/responses' ? null : <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-compact" aria-label={t('providers.edit')} onClick={() => openEdit(provider)}><Pencil /></Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('providers.edit')}</TooltipContent>
                    </Tooltip>}
                    {provider.name === 'codex' && provider.protocol === 'codex/responses' ? null : <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-compact" aria-label={t('providers.delete')} onClick={() => { setDeleteError(''); setDeleteProvider(provider); }}><Trash2 /></Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('providers.delete')}</TooltipContent>
                    </Tooltip>}
                  </div>
                </CollectionRow>
              ))}
            </CollectionTable>
          )}
        </div>
      </section>
        </TabsContent>
        <TabsContent value="codex">
          <CodexAccountPool auth={codexAuthQuery.data} usage={codexUsageQuery.data} usageLoading={codexUsageQuery.isLoading} usageError={codexUsageQuery.isError} authBusy={codexAuthBusy} onLogin={() => void startCodexAuth()} importRef={codexImportRef} onImport={(file) => void importCodexAccounts(file)} onToggleAccount={(accountId, enabled) => void setCodexAccountEnabled(accountId, enabled)} onRefreshAccount={(accountId) => void refreshCodexAccount(accountId)} onDeleteAccount={(accountId) => void deleteCodexAccount(accountId)} onRefreshAll={() => void refreshCodexUsages()} locale={locale} t={(key) => t(key as never)} />
        </TabsContent>
        <TabsContent value="statistics">
          <GatewayStatistics stats={statsQuery.data} isLoading={statsQuery.isLoading} isError={statsQuery.isError} window={statsWindow} onWindowChange={setStatsWindow} locale={locale} t={(key) => t(key as never)} />
        </TabsContent>
      </Tabs>

      <Dialog open={Boolean(dialog)} onOpenChange={(open) => !open && closeProviderDialog()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t(dialog?.mode === 'edit' ? 'providers.editTitle' : 'providers.createTitle')}</DialogTitle>
            <DialogDescription>{t(dialog?.mode === 'edit' ? 'providers.editDescription' : 'providers.createDescription')}</DialogDescription>
          </DialogHeader>
          {providerError ? <p className="text-[13px] text-danger" role="alert">{providerError}</p> : null}
          <Field label={t('providers.name')} htmlFor="provider-name"><Input id="provider-name" placeholder={t('providers.namePlaceholder')} value={name} onChange={(event) => setName(event.target.value)} disabled={providerBusy} /></Field>
          <Field label={t('providers.baseURL')} htmlFor="provider-base-url" hint={t('providers.baseURLHint')}><Input id="provider-base-url" placeholder={t('providers.baseURLPlaceholder')} value={baseURL} onChange={(event) => setBaseURL(event.target.value)} /></Field>
          <Field label={t('providers.protocol')} htmlFor="provider-protocol">
            <Select value={protocol} onValueChange={(value) => setProtocol(value as ModelProviderProtocol)}>
              <SelectTrigger id="provider-protocol"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="openai/chat">openai/chat</SelectItem>
                <SelectItem value="openai/responses">openai/responses</SelectItem>
                {dialog?.mode === 'edit' && protocol === 'codex/responses' ? <SelectItem value="codex/responses">codex/responses</SelectItem> : null}
                <SelectItem value="deepseek/chat">deepseek/chat</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('providers.apiKey')} htmlFor="provider-api-key">
            <PasswordInput id="provider-api-key" autoComplete="off" placeholder={t(dialog?.mode === 'edit' ? 'providers.keepSecretPlaceholder' : 'providers.secretPlaceholder')} value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          </Field>
          <Field label={t('providers.models')} htmlFor="provider-models" hint={t('providers.modelsHint')} error={modelsError}>
            <div className="flex flex-col gap-2">
              <ModelTokenInput id="provider-models" value={modelIds} onChange={(value) => { setModelIds(value); setModelsError(''); }} placeholder={t('providers.modelsPlaceholder')} removeLabel={(model) => t('providers.removeModel', { model })} disabled={providerBusy || modelsBusy} />
              <div className="flex items-center justify-between gap-3">
                <Button variant="secondary" size="compact" onClick={() => void discoverModels()} disabled={providerBusy || modelsBusy || (protocol !== 'codex/responses' && !apiKey.trim())}>
                  {modelsBusy ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <RefreshCw className="size-4" aria-hidden="true" />}
                  {modelsBusy ? t('providers.fetchingModels') : t('providers.fetchModels')}
                </Button>
                <span className="text-xs tabular-nums text-muted-foreground">{t('providers.modelCount', { count: modelIds.length })}</span>
              </div>
            </div>
          </Field>
          <Field label={t('providers.headers')} htmlFor="provider-headers" hint={t('providers.headersHint')} error={headersError}><Textarea id="provider-headers" className="min-h-28 font-mono text-[13px]" placeholder={t('providers.headersPlaceholder')} value={headersText} aria-invalid={Boolean(headersError)} onChange={(event) => { setHeadersText(event.target.value); setHeadersError(''); }} /></Field>
          <DialogFooter>
            <Button variant="secondary" onClick={closeProviderDialog} disabled={providerBusy}>{t('common:actions.cancel')}</Button>
            <Button onClick={() => void saveProvider()} disabled={providerBusy || !name.trim()}>{providerBusy ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}{t(dialog?.mode === 'edit' ? 'providers.editAction' : 'providers.createAction')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(testDialog)} onOpenChange={(open) => !open && setTestDialog(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('providers.testTitle', { provider: testDialog?.provider.name })}</DialogTitle>
            <DialogDescription>
              {testDialog?.status === 'success' ? t('providers.testDescriptionWithModel', { model: testDialog.result.model }) : t('providers.testDescription')}
            </DialogDescription>
          </DialogHeader>
          <Field label={t('providers.testModel')} htmlFor="provider-test-model">
            <Select value={testDialog?.model ?? ''} onValueChange={selectTestModel} disabled={testDialog?.status === 'loading'}>
              <SelectTrigger id="provider-test-model"><SelectValue placeholder={t('providers.testModelPlaceholder')} /></SelectTrigger>
              <SelectContent>{testDialog?.provider.models.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {testDialog?.status !== 'idle' ? <div className="flex min-h-52 flex-col gap-5 py-2">
            <div className="flex justify-end">
              <div className="max-w-[80%] rounded-md bg-brand px-4 py-3 text-sm text-white">
                <p className="sr-only">{t('providers.testPromptLabel')}</p>
                <p className="whitespace-pre-wrap">{testDialog?.status === 'success' ? testDialog.result.prompt : PROVIDER_TEST_PROMPT}</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-subtle text-brand" aria-hidden="true"><Bot className="size-4" /></div>
              <div className="min-w-0 flex-1 rounded-md border border-border bg-surface-subtle px-4 py-3 text-sm">
                <p className="sr-only">{t('providers.testReplyLabel')}</p>
                {testDialog?.status === 'loading' ? (
                  <div className="flex items-center gap-2 text-muted-foreground"><LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /><span className="sr-only">{t('providers.waitingReplyAccessible')}</span><span aria-hidden="true" className="tabular-nums">{t('providers.waitingReply', { seconds: testDialog.elapsedSeconds })}</span></div>
                ) : testDialog?.status === 'success' ? (
                  <div aria-live="polite"><p className="whitespace-pre-wrap break-words">{testDialog.result.response}</p><p className="mt-3 border-t border-border pt-2 text-xs tabular-nums text-muted-foreground">{t('providers.testDuration', { seconds: testDialog.elapsedSeconds })}</p></div>
                ) : testDialog?.status === 'error' ? (
                  <><p role="alert" className="break-words text-danger">{testDialog.message}</p>{testDialog.traceId ? <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2"><span className="font-mono text-xs text-muted-foreground">{t('providers.traceId', { id: testDialog.traceId })}</span><Button type="button" variant="ghost" size="compact" onClick={() => window.location.assign(`/settings/logs?traceId=${encodeURIComponent(testDialog.traceId ?? '')}`)}>{t('providers.viewLogs')}</Button></div> : null}<p className="mt-3 border-t border-border pt-2 text-xs tabular-nums text-muted-foreground">{t('providers.testDuration', { seconds: testDialog.elapsedSeconds })}</p></>
                ) : null}
              </div>
            </div>
          </div> : null}
          <DialogFooter><Button variant="secondary" onClick={() => setTestDialog(null)}>{t('common:actions.close')}</Button><Button onClick={runProviderTest} disabled={!testDialog?.model || testDialog?.status === 'loading'}>{testDialog?.status === 'loading' ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}{t('providers.runTest')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteProvider)} onOpenChange={(open) => { if (!open && !deleteBusy) { setDeleteProvider(null); setDeleteError(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('providers.deleteTitle', { provider: deleteProvider?.name })}</DialogTitle>
            <DialogDescription>{t('providers.deleteDescription')}</DialogDescription>
          </DialogHeader>
          {deleteError ? <p className="text-[13px] text-danger" role="alert">{deleteError}</p> : null}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleteProvider(null)} disabled={deleteBusy}>{t('common:actions.cancel')}</Button>
            <Button variant="destructive" onClick={() => void removeProvider()} disabled={deleteBusy}>{deleteBusy ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}{t('providers.deleteAction')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function GatewayPanel({ gateway, providers, auth, t }: { gateway?: { port: number; host: string; status: PortkeyGatewayStatus; error: string | null }; providers: ModelProviderView[]; auth?: CodexAuthStatus; t: (key: string) => string }) {
  const status = gateway?.status ?? 'starting';
  const running = status === 'running';
  const publicBaseUrl = `${typeof window === 'undefined' ? '' : window.location.origin}/api/portkey-gateway/v1`;
  const namespacedModels = providers.flatMap((provider) => provider.models.map((model) => `${provider.name}/${model}`));
  const exampleModel = namespacedModels[0] ?? '<providerName>/<modelId>';
  const configExample = JSON.stringify({ base_url: publicBaseUrl, api_key: 'not-required', model: exampleModel }, null, 2);
  async function copyValue(value: string) { if (!navigator.clipboard) return; await navigator.clipboard.writeText(value); toast.success(t('providers.gateway.copied')); }
  return <section className="mt-6 w-full rounded-lg border border-border bg-surface p-4">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-base font-semibold">{t('providers.gateway.title')}</h2><p className="mt-1 text-[13px] text-muted-foreground">{t('providers.gateway.description')}</p></div><div className="shrink-0"><p className="text-xs font-medium text-muted-foreground">{t('providers.gateway.status')}</p><div className="mt-1"><StatusBadge status={running ? 'gateway_running' : status} /></div></div></div>
    <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground"><span><span className="font-medium">{t('providers.gateway.port')}:</span> <code className="font-mono text-foreground">{gateway?.port ?? 4547}</code></span><span className="font-mono">{gateway ? `http://${gateway.host}:${gateway.port}` : t('providers.gateway.loading')}</span></div>
    {gateway?.error ? <p className="text-[13px] text-danger" role="alert">{gateway.error}</p> : null}
    <div className="mt-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">{t('providers.gateway.codex.title')}</h3><p className="mt-1 text-[13px] text-muted-foreground">{t('providers.gateway.codex.description')}</p></div><StatusBadge status={auth?.status === 'connected' ? 'connected' : auth?.status === 'login_pending' ? 'pending' : auth?.status === 'error' ? 'invalid' : 'unconfigured'} /></div>
      {auth?.error ? <p className="mt-2 text-[13px] text-danger" role="alert">{auth.error}</p> : null}
      <p className="mt-3 text-[13px] text-muted-foreground">{t('providers.gateway.codex.manageInPool')}</p>
    </div>
    <details className="group mt-4 border-t border-border pt-3"><summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40">{t('providers.gateway.integrationTitle')}<ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" /></summary><p className="mt-2 text-[13px] text-muted-foreground">{t('providers.gateway.integrationDescription')}</p><div className="mt-3 grid gap-3 lg:grid-cols-2"><GatewayCodeBlock label={t('providers.gateway.baseURL')} value={publicBaseUrl} copyLabel={t('providers.gateway.copyBaseURL')} onCopy={copyValue} /><GatewayCodeBlock label={t('providers.gateway.example')} value={configExample} copyLabel={t('providers.gateway.copyExample')} onCopy={copyValue} /></div></details>
  </section>;
}
function GatewayCodeBlock({ label, value, copyLabel, onCopy }: { label: string; value: string; copyLabel: string; onCopy: (value: string) => void }) {
  return <div className="rounded-md border border-border bg-background p-3"><div className="flex items-center justify-between gap-3"><p className="text-xs font-medium text-muted-foreground">{label}</p><Button variant="ghost" size="icon" aria-label={copyLabel} onClick={() => void onCopy(value)}><Copy className="size-4" /></Button></div><pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground">{value}</pre></div>;
}

type CodexAccountPoolProps = {
  auth?: CodexAuthStatus;
  usage?: CodexAccountUsageSnapshot;
  usageLoading: boolean;
  usageError: boolean;
  authBusy: boolean;
  onLogin: () => void;
  importRef: RefObject<HTMLInputElement | null>;
  onImport: (file: File) => void;
  onToggleAccount: (accountId: string, enabled: boolean) => void;
  onRefreshAccount: (accountId: string) => void;
  onDeleteAccount: (accountId: string) => void;
  onRefreshAll: () => void;
  locale: AppLocale;
  t: (key: string) => string;
};

function CodexAccountPool({ auth, usage, usageLoading, usageError, authBusy, onLogin, importRef, onImport, onToggleAccount, onRefreshAccount, onDeleteAccount, onRefreshAll, locale, t }: CodexAccountPoolProps) {
  const usageByAccountId = new Map((usage?.accounts ?? []).map((item) => [item.accountId, item]));
  const accounts = auth?.accounts ?? [];
  return <section className="space-y-5" aria-labelledby="codex-account-pool-title">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 id="codex-account-pool-title" className="text-base font-semibold">{t('providers.codexPool.title')}</h2><p className="mt-1 text-[13px] text-muted-foreground">{t('providers.codexPool.description')}</p></div>
      <div className="flex flex-wrap gap-2">
        <Button size="compact" onClick={onLogin} disabled={authBusy}><LogIn className="size-4" />{auth?.status === 'login_pending' ? t('providers.gateway.codex.loginPending') : t('providers.gateway.codex.addAccount')}</Button>
        <input ref={importRef} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); }} />
        <Button variant="secondary" size="compact" onClick={() => importRef.current?.click()} disabled={authBusy}><Upload className="size-4" />{t('providers.gateway.codex.import')}</Button>
        <Button variant="secondary" size="compact" onClick={onRefreshAll} disabled={authBusy || usageLoading || accounts.length === 0}><RefreshCw className="size-4" />{t('providers.codexPool.refreshAll')}</Button>
      </div>
    </div>
    {auth?.error ? <p className="text-[13px] text-danger" role="alert">{auth.error}</p> : null}
    {usageError ? <p className="text-[13px] text-danger" role="alert">{t('providers.codexPool.usageError')}</p> : null}
    {usageLoading && accounts.length > 0 ? <p className="text-sm text-muted-foreground" role="status">{t('providers.codexPool.loading')}</p> : null}
    {accounts.length === 0 ? <EmptyState title={t('providers.codexPool.emptyTitle')} description={t('providers.codexPool.emptyDescription')} /> : <div className="grid gap-4 xl:grid-cols-2">
      {accounts.map((account) => {
        const accountUsage = usageByAccountId.get(account.id);
        return <CodexAccountCard key={account.id} account={account} usage={accountUsage} authBusy={authBusy} locale={locale} t={t} onToggle={onToggleAccount} onRefresh={onRefreshAccount} onDelete={onDeleteAccount} />;
      })}
    </div>}
    {usage?.fetchedAt ? <p className="text-xs text-muted-foreground">{t('providers.codexPool.fetchedAt')}: {formatDateTime(usage.fetchedAt, locale)}</p> : null}
  </section>;
}

function CodexAccountCard({ account, usage, authBusy, locale, t, onToggle, onRefresh, onDelete }: { account: CodexAuthStatus['accounts'][number]; usage?: CodexAccountUsageSnapshot['accounts'][number]; authBusy: boolean; locale: AppLocale; t: (key: string) => string; onToggle: (accountId: string, enabled: boolean) => void; onRefresh: (accountId: string) => void; onDelete: (accountId: string) => void }) {
  const status = usage?.status ?? account.status;
  const statusBadge = status === 'disabled' ? 'disabled' : status === 'expired' ? 'invalid' : status === 'error' ? 'error' : status === 'unavailable' ? 'missing' : status === 'connected' ? 'connected' : 'unconfigured';
  const accountLabel = account.email || account.name;
  const identity = account.accountId || account.id;
  return <article className="rounded-lg border border-border bg-surface p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><p className="truncate text-sm font-semibold">{accountLabel}</p><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{t('providers.codexPool.accountId')}: {maskAccountId(identity)}</p></div>
      <StatusBadge status={statusBadge} />
    </div>
    <div className="mt-4 grid gap-3 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
      <Detail label={t('providers.codexPool.plan')} value={account.planType || usage?.planType || t('providers.gateway.codex.unknownPlan')} />
      <Detail label={t('providers.gateway.codex.concurrency')} value={String(account.concurrency)} />
      <Detail label={t('providers.gateway.codex.priority')} value={String(account.priority)} />
      <Detail label={t('providers.codexPool.expiresAt')} value={account.expiresAt ? formatDateTime(account.expiresAt, locale) : t('providers.codexPool.quotaUnavailable')} />
    </div>
    {account.error ? <p className="mt-3 text-xs text-danger" role="alert">{account.error}</p> : null}
    {usage?.error ? <p className="mt-3 text-xs text-danger" role="alert">{usage.error}</p> : null}
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <CodexQuotaWindow title={t('providers.codexPool.primary')} window={usage?.primary ?? null} locale={locale} t={t} />
      <CodexQuotaWindow title={t('providers.codexPool.secondary')} window={usage?.secondary ?? null} locale={locale} t={t} />
    </div>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
      <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{account.enabled ? t('providers.gateway.codex.enabled') : t('providers.gateway.codex.disabled')}</span><Switch checked={account.enabled} disabled={authBusy} aria-label={`${account.enabled ? t('providers.gateway.codex.disable') : t('providers.gateway.codex.enable')} ${accountLabel}`} onCheckedChange={(enabled) => onToggle(account.id, enabled)} /></div>
      <div className="flex items-center gap-1"><Button variant="ghost" size="icon" aria-label={`${t('providers.gateway.codex.refresh')} ${accountLabel}`} onClick={() => onRefresh(account.id)} disabled={authBusy || !account.enabled}><RefreshCw className="size-4" /></Button><Button variant="ghost" size="icon" aria-label={`${t('providers.gateway.codex.remove')} ${accountLabel}`} onClick={() => onDelete(account.id)} disabled={authBusy}><Trash2 className="size-4" /></Button></div>
    </div>
    {usage?.fetchedAt ? <p className="mt-2 text-right text-xs text-muted-foreground">{t('providers.codexPool.fetchedAt')}: {formatDateTime(usage.fetchedAt, locale)}</p> : null}
  </article>;
}

function CodexQuotaWindow({ title, window, locale, t }: { title: string; window: CodexRateLimitWindow | null; locale: AppLocale; t: (key: string) => string }) {
  if (!window) return <div className="rounded-md border border-border bg-surface-subtle p-3"><p className="text-xs font-medium text-muted-foreground">{title}</p><p className="mt-2 text-xs text-muted-foreground">{t('providers.codexPool.quotaUnavailable')}</p></div>;
  const used = Math.min(100, Math.max(0, Math.round(window.usedPercent)));
  const remaining = 100 - used;
  return <div className="rounded-md border border-border bg-surface-subtle p-3">
    <div className="flex items-center justify-between gap-3"><p className="text-xs font-medium text-muted-foreground">{title}</p><span className="text-xs font-semibold tabular-nums">{remaining}% {t('providers.codexPool.remaining')}</span></div>
    <div className="mt-2 h-2 overflow-hidden rounded-full bg-border" role="progressbar" aria-label={`${title} ${t('providers.codexPool.remaining')}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining}><div className="h-full rounded-full bg-brand transition-[width] motion-reduce:transition-none" style={{ width: `${remaining}%` }} /></div>
    <div className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{used}% {t('providers.codexPool.used')}</span><span>{t('providers.codexPool.resets')}: {formatDateTime(window.resetsAt, locale)}</span></div>
  </div>;
}

function maskAccountId(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function GatewayStatistics({ stats, isLoading, isError, window, onWindowChange, locale, t }: { stats?: PortkeyGatewayStats; isLoading: boolean; isError: boolean; window: '24h' | '7d' | '30d'; onWindowChange: (value: '24h' | '7d' | '30d') => void; locale: AppLocale; t: (key: string) => string }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const summary = stats?.summary;
  const metricValue = (value: number | null, suffix = '') => value === null ? t('providers.statistics.unavailable') : `${formatNumber(value, locale)}${suffix}`;
  return (
    <section className="space-y-5" aria-labelledby="gateway-statistics-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 id="gateway-statistics-title" className="text-base font-semibold">{t('providers.statistics.title')}</h2><p className="mt-1 text-[13px] text-muted-foreground">{t('providers.statistics.description')}</p></div>
        <Select value={window} onValueChange={(value) => onWindowChange(value as '24h' | '7d' | '30d')}>
          <SelectTrigger className="w-36" aria-label={t('providers.statistics.window')}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="24h">{t('providers.statistics.last24h')}</SelectItem><SelectItem value="7d">{t('providers.statistics.last7d')}</SelectItem><SelectItem value="30d">{t('providers.statistics.last30d')}</SelectItem></SelectContent>
        </Select>
      </div>
      {isLoading ? <p className="text-sm text-muted-foreground">{t('providers.statistics.loading')}</p> : isError ? <p className="text-sm text-danger" role="alert">{t('providers.statistics.error')}</p> : !stats || stats.summary.requests === 0 ? <EmptyState title={t('providers.statistics.emptyTitle')} description={t('providers.statistics.emptyDescription')} /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label={t('providers.statistics.requests')} value={formatNumber(summary?.requests ?? 0, locale)} />
            <Metric label={t('providers.statistics.successRate')} value={summary?.successRate === null ? t('providers.statistics.unavailable') : `${summary?.successRate}%`} />
            <Metric label={t('providers.statistics.averageLatency')} value={metricValue(summary?.averageLatencyMs ?? null, ' ms')} />
            <Metric label={t('providers.statistics.totalTokens')} value={metricValue(summary?.totalTokens ?? null)} />
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-surface">
            <div className="hidden grid-cols-[1.2fr_1.4fr_0.7fr_0.8fr_0.9fr] gap-3 border-b border-border bg-background px-4 py-2 text-xs font-medium text-muted-foreground md:grid"><span>{t('providers.statistics.provider')}</span><span>{t('providers.statistics.model')}</span><span>{t('providers.statistics.requests')}</span><span>{t('providers.statistics.successRate')}</span><span>{t('providers.statistics.averageLatency')}</span></div>
            {stats.breakdown.map((row) => {
              const key = `${row.provider}\u0000${row.model}`;
              const open = expanded === key;
              const rate = row.requests ? Math.round((row.successful / row.requests) * 1000) / 10 : null;
              return <div key={key} className="border-b border-border last:border-b-0"><button type="button" className="grid w-full grid-cols-1 gap-2 px-4 py-3 text-left hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45 md:grid-cols-[1.2fr_1.4fr_0.7fr_0.8fr_0.9fr] md:items-center md:gap-3" onClick={() => setExpanded(open ? null : key)} aria-expanded={open}><span className="font-medium">{row.provider}</span><span className="font-mono text-xs text-muted-foreground break-all">{row.model}</span><span className="tabular-nums text-[13px]">{formatNumber(row.requests, locale)}</span><span className="tabular-nums text-[13px]">{rate === null ? t('providers.statistics.unavailable') : `${rate}%`}</span><span className="tabular-nums text-[13px] text-muted-foreground">{metricValue(row.averageLatencyMs, ' ms')} <ChevronDown className={`ml-1 inline size-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" /></span></button>{open ? <div className="grid gap-4 border-t border-border bg-surface-subtle px-4 py-4 text-[13px] sm:grid-cols-3"><Detail label={t('providers.statistics.endpoints')} value={row.endpoints.map((item) => `${item.endpoint} (${item.requests})`).join(', ') || t('providers.statistics.unavailable')} /><Detail label={t('providers.statistics.statuses')} value={row.statuses.map((item) => `${item.status} (${item.requests})`).join(', ') || t('providers.statistics.unavailable')} /><Detail label={t('providers.statistics.tokens')} value={`${t('providers.statistics.input')}: ${metricValue(row.promptTokens)} · ${t('providers.statistics.output')}: ${metricValue(row.completionTokens)} · ${t('providers.statistics.total')}: ${metricValue(row.totalTokens)}`} /></div> : null}</div>;
            })}
          </div>
          <p className="text-xs text-muted-foreground">{t('providers.statistics.windowRange')} {stats.from ? formatDateTime(stats.from, locale) : '-'} - {stats.to ? formatDateTime(stats.to, locale) : '-'}</p>
        </>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-border bg-surface p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-lg font-semibold tabular-nums">{value}</p></div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-1 break-words font-mono text-xs">{value}</p></div>;
}

function currentTime(): number {
  return Date.now();
}
