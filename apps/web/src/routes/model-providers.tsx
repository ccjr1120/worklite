import { createFileRoute } from '@tanstack/react-router';
import { BarChart3, Bot, ChevronDown, Copy, KeyRound, LoaderCircle, LogIn, Pencil, Plus, RefreshCw, Trash2, Unplug, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { CodexAuthStatus, CodexRateLimitSnapshot, CodexRateLimitWindow, DiscoverModelProviderRequest, ModelProviderProtocol, ModelProviderTestResult, ModelProviderView, PortkeyGatewayStats, PortkeyGatewayStatus } from '@worklite/contracts';
import { CollectionTable, CollectionHeader, CollectionRow } from '@/components/collection-table';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { EmptyState } from '@/components/empty-state';
import { PageHeading } from '@/components/page-heading';
import { Field } from '@/components/ui/field';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/password-input';
import { StatusBadge } from '@/components/status-badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useCodexAuthQuery, useCodexRateLimitsQuery, useModelProvidersQuery, usePortkeyGatewayQuery } from '@/api/queries';
import { usePortkeyGatewayStatsQuery } from '@/api/queries';
import { api } from '@/api/client';
import { queryClient } from '@/lib/query-client';
import { formatDateTime, formatList, formatNumber } from '@/i18n/format';
import { useLocale } from '@/components/locale-provider';
import type { AppLocale } from '@/i18n/locale';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export const Route = createFileRoute('/model-providers')({
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
  const [view, setView] = useState<'providers' | 'statistics'>('providers');
  const [statsWindow, setStatsWindow] = useState<'24h' | '7d' | '30d'>('24h');
  const { data: modelProviders = [], isLoading, isError } = useModelProvidersQuery(workspaceSlug);
  const gatewayQuery = usePortkeyGatewayQuery();
  const codexAuthQuery = useCodexAuthQuery();
  const codexRateLimitsQuery = useCodexRateLimitsQuery(codexAuthQuery.data?.status === 'connected');
  const [codexAuthBusy, setCodexAuthBusy] = useState(false);
  const statsQuery = usePortkeyGatewayStatsQuery(statsWindow);
  const items = useMemo(
    () => modelProviders.filter((provider) => `${provider.name} ${provider.models.join(' ')}`.toLowerCase().includes(search.toLowerCase())),
    [modelProviders, search],
  );

  useEffect(() => {
    if (codexAuthQuery.data?.status === 'connected' || codexAuthQuery.data?.status === 'disconnected' || codexAuthQuery.data?.status === 'error') {
      void queryClient.invalidateQueries({ queryKey: ['model-providers'] }).catch(() => undefined);
    }
  }, [codexAuthQuery.data?.status]);

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

  async function refreshCodexAuth() {
    setCodexAuthBusy(true);
    try { await api.refreshCodexCredential(); await codexAuthQuery.refetch(); await codexRateLimitsQuery.refetch(); toast.success(t('providers.gateway.codex.refreshed')); } catch (error) { toast.error(error instanceof Error ? error.message : t('providers.gateway.codex.refreshFailed')); } finally { setCodexAuthBusy(false); }
  }

  async function logoutCodexAuth() {
    setCodexAuthBusy(true);
    try { await api.logoutCodex(); await codexAuthQuery.refetch(); toast.success(t('providers.gateway.codex.loggedOut')); } catch (error) { toast.error(error instanceof Error ? error.message : t('providers.gateway.codex.logoutFailed')); } finally { setCodexAuthBusy(false); }
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
      setDeleteError(error instanceof Error ? error.message : t('providers.testFailed'));
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
      <GatewayPanel
        gateway={gatewayQuery.data}
        providers={modelProviders}
        auth={codexAuthQuery.data}
        rateLimits={codexRateLimitsQuery.data}
        rateLimitsLoading={codexRateLimitsQuery.isLoading}
        rateLimitsError={codexRateLimitsQuery.isError}
        authBusy={codexAuthBusy}
        onLogin={() => void startCodexAuth()}
        onRefresh={() => void refreshCodexAuth()}
        onLogout={() => void logoutCodexAuth()}
        locale={locale}
        t={(key) => t(key as never)}
      />
      <Tabs value={view} onValueChange={(value) => setView(value as 'providers' | 'statistics')} className="mt-6">
        <TabsList aria-label={t('providers.views.label')}>
          <TabsTrigger value="providers">{t('providers.views.providers')}</TabsTrigger>
          <TabsTrigger value="statistics"><BarChart3 className="size-4" />{t('providers.views.statistics')}</TabsTrigger>
        </TabsList>
        <TabsContent value="providers">
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
              <CollectionHeader columns={[t('providers.columns.provider'), t('providers.columns.status'), t('providers.columns.models'), t('providers.columns.credential'), t('providers.columns.actions')]} />
              {items.map((provider) => (
                <CollectionRow key={provider.id} className="min-w-[900px]">
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

      <Dialog open={Boolean(deleteProvider)} onOpenChange={(open) => !open && setDeleteProvider(null)}>
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

function rateLimitLabel(window: CodexRateLimitWindow, t: (key: string) => string): string {
  const minutes = Math.round(window.limitWindowSeconds / 60);
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)} ${t('providers.gateway.codex.days')}`;
  if (minutes % 60 === 0) return `${minutes / 60} ${t('providers.gateway.codex.hours')}`;
  return `${minutes} ${t('providers.gateway.codex.minutes')}`;
}

function GatewayPanel({ gateway, providers, auth, rateLimits, rateLimitsLoading, rateLimitsError, authBusy, onLogin, onRefresh, onLogout, locale, t }: { gateway?: { port: number; host: string; status: PortkeyGatewayStatus; error: string | null }; providers: ModelProviderView[]; auth?: CodexAuthStatus; rateLimits?: CodexRateLimitSnapshot; rateLimitsLoading: boolean; rateLimitsError: boolean; authBusy: boolean; onLogin: () => void; onRefresh: () => void; onLogout: () => void; locale: AppLocale; t: (key: string) => string }) {
  const status = gateway?.status ?? 'starting';
  const running = status === 'running';
  const publicBaseUrl = `${typeof window === 'undefined' ? '' : window.location.origin}/api/portkey-gateway/v1`;
  const namespacedModels = providers.flatMap((provider) => provider.models.map((model) => `${provider.name}/${model}`));
  const exampleModel = namespacedModels[0] ?? '<providerName>/<modelId>';
  const configExample = JSON.stringify({ base_url: publicBaseUrl, api_key: 'not-required', model: exampleModel }, null, 2);
  async function copyValue(value: string) {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(value);
    toast.success(t('providers.gateway.copied'));
  }
  return <section className="mt-6 w-full rounded-lg border border-border bg-surface p-4">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="text-base font-semibold">{t('providers.gateway.title')}</h2><p className="mt-1 text-[13px] text-muted-foreground">{t('providers.gateway.description')}</p></div>
      <div className="shrink-0"><p className="text-xs font-medium text-muted-foreground">{t('providers.gateway.status')}</p><div className="mt-1"><StatusBadge status={running ? 'gateway_running' : status} /></div></div>
    </div>
    <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
      <span><span className="font-medium">{t('providers.gateway.port')}:</span> <code className="font-mono text-foreground">{gateway?.port ?? 4547}</code></span>
      <span className="font-mono">{gateway ? `http://${gateway.host}:${gateway.port}` : t('providers.gateway.loading')}</span>
    </div>
    {gateway?.error ? <p className="text-[13px] text-danger" role="alert">{gateway.error}</p> : null}
    <div className="mt-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="text-sm font-semibold">{t('providers.gateway.codex.title')}</h3><p className="mt-1 text-[13px] text-muted-foreground">{t('providers.gateway.codex.description')}</p></div>
        <StatusBadge status={auth?.status === 'connected' ? 'connected' : auth?.status === 'login_pending' ? 'pending' : auth?.status === 'error' ? 'invalid' : 'unconfigured'} />
      </div>
      {auth?.email ? <p className="mt-2 text-xs text-muted-foreground">{auth.email}{auth.planType ? ` · ${auth.planType}` : ''}</p> : null}
      {auth?.error ? <p className="mt-2 text-[13px] text-danger" role="alert">{auth.error}</p> : null}
      {auth?.status === 'connected' ? <CodexRateLimits snapshot={rateLimits} isLoading={rateLimitsLoading} isError={rateLimitsError} locale={locale} t={t} /> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {auth?.status === 'connected' && auth.authMethod === 'oauth' ? <><Button variant="secondary" size="compact" onClick={onRefresh} disabled={authBusy}><RefreshCw className={authBusy ? 'size-4 motion-safe:animate-spin' : 'size-4'} />{t('providers.gateway.codex.refresh')}</Button><Button variant="ghost" size="compact" onClick={onLogout} disabled={authBusy}><Unplug className="size-4" />{t('providers.gateway.codex.logout')}</Button></> : auth?.status === 'connected' && auth.authMethod === 'environment' ? <Button variant="secondary" size="compact" onClick={onLogin} disabled={authBusy}><LogIn className="size-4" />{t('providers.gateway.codex.login')}</Button> : <Button size="compact" onClick={onLogin} disabled={authBusy}><LogIn className="size-4" />{auth?.status === 'login_pending' ? t('providers.gateway.codex.loginPending') : t('providers.gateway.codex.login')}</Button>}
      </div>
    </div>
    <details className="group mt-4 border-t border-border pt-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40">
        {t('providers.gateway.integrationTitle')}
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="mt-4 space-y-4">
        <p className="text-[13px] text-muted-foreground">{t('providers.gateway.integrationDescription')}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0"><p className="text-xs font-medium text-muted-foreground">{t('providers.gateway.baseURL')}</p><div className="mt-2 flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded-md bg-surface-subtle px-2.5 py-2 font-mono text-xs">{publicBaseUrl}</code><Button variant="ghost" size="icon-compact" aria-label={t('providers.gateway.copyBaseURL')} onClick={() => void copyValue(publicBaseUrl)}><Copy /></Button></div></div>
          <div><p className="text-xs font-medium text-muted-foreground">{t('providers.gateway.apiKey')}</p><p className="mt-2 font-mono text-sm">{t('providers.gateway.noApiKey')}</p></div>
        </div>
        <div><p className="text-xs font-medium text-muted-foreground">{t('providers.gateway.models')}</p>{namespacedModels.length ? <div className="mt-2 flex flex-wrap gap-1.5">{namespacedModels.map((model) => <code key={model} className="rounded-md border border-border bg-surface-subtle px-2 py-1 font-mono text-xs">{model}</code>)}</div> : <p className="mt-2 text-[13px] text-muted-foreground">{t('providers.gateway.noModels')}</p>}</div>
        <div><div className="flex items-center justify-between gap-3"><p className="text-xs font-medium text-muted-foreground">{t('providers.gateway.example')}</p><Button variant="ghost" size="compact" onClick={() => void copyValue(configExample)}><Copy className="size-3.5" />{t('providers.gateway.copyExample')}</Button></div><pre className="mt-2 overflow-x-auto rounded-md border border-border bg-surface-subtle p-3 font-mono text-xs text-foreground"><code>{configExample}</code></pre></div>
      </div>
    </details>
  </section>;
}

function CodexRateLimits({ snapshot, isLoading, isError, locale, t }: { snapshot?: CodexRateLimitSnapshot; isLoading: boolean; isError: boolean; locale: AppLocale; t: (key: string) => string }) {
  const rows = snapshot?.limits.flatMap((limit) => [
    ...(limit.primary ? [{ key: `${limit.id}-primary`, name: limit.name, window: limit.primary }] : []),
    ...(limit.secondary ? [{ key: `${limit.id}-secondary`, name: limit.name, window: limit.secondary }] : []),
  ]) ?? [];
  if (isLoading) return <p className="mt-3 text-xs text-muted-foreground">{t('providers.gateway.codex.rateLimitsLoading')}</p>;
  if (isError || !snapshot) return <p className="mt-3 text-xs text-muted-foreground" role="status">{t('providers.gateway.codex.rateLimitsUnavailable')}</p>;
  if (!rows.length) return <p className="mt-3 text-xs text-muted-foreground">{t('providers.gateway.codex.rateLimitsEmpty')}</p>;
  return <div className="mt-3 grid gap-2 sm:grid-cols-2">
    {rows.map((row) => {
      const used = Math.min(100, Math.max(0, row.window.usedPercent));
      return <div key={row.key} className="rounded-md border border-border bg-surface-subtle px-3 py-2">
        <div className="flex items-center justify-between gap-3 text-xs"><span className="font-medium">{row.name || rateLimitLabel(row.window, t)}</span><span className="tabular-nums text-muted-foreground">{formatNumber(row.window.usedPercent, locale)}% {t('providers.gateway.codex.used')}</span></div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface" role="progressbar" aria-label={row.name || rateLimitLabel(row.window, t)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used)}><div className="h-full rounded-full bg-muted-foreground" style={{ width: `${used}%` }} /></div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">{t('providers.gateway.codex.resets')} {formatDateTime(row.window.resetsAt, locale)}</p>
      </div>;
    })}
  </div>;
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
