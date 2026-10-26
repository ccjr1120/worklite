import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { BarChart3, Bot, ChevronDown, Copy, GripVertical, KeyRound, LoaderCircle, LogIn, Pencil, Plus, RefreshCw, ScrollText, Trash2, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { CodexAccountUsageSnapshot, CodexAuthStatus, CodexRateLimitWindow, DiscoverModelProviderRequest, ModelProviderProtocol, ModelProviderTestResult, ModelProviderView, PortkeyGatewayStatus, SystemOneTestInput } from '@worklite/contracts';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CollectionTable, CollectionHeader, CollectionRow } from '@/components/collection-table';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { CollectionLoading } from '@/components/collection-loading';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
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
import { CHAT_AGENT_ID } from '@worklite/contracts';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useCodexAccountUsagesQuery, useCodexAuthQuery, useModelProvidersQuery, usePortkeyGatewayQuery } from '@/api/queries';
import { ApiError, api } from '@/api/client';
import { queryClient } from '@/lib/query-client';
import { formatDateTime, formatList } from '@/i18n/format';
import { useLocale } from '@/components/locale-provider';
import type { AppLocale } from '@/i18n/locale';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GatewayStatistics } from '@/features/logs/gateway-statistics';
import { GatewayRequestLogs, type RequestLogFilters } from '@/features/logs/request-logs';
import { WebSearchSettings } from '@/features/web-search-settings';

type ProviderActivity = { provider: ModelProviderView; from: string; to: string; model?: string; statusClass?: RequestLogFilters['statusClass'] };

type ModelProvidersSearch = {
  provider?: string;
};

function isBuiltInCodexProvider(provider: ModelProviderView): boolean {
  return provider.name === 'codex' && provider.protocol === 'codex/responses';
}

export const Route = createFileRoute('/model-providers')({
  validateSearch: (search: Record<string, unknown>): ModelProvidersSearch => ({
    provider: typeof search.provider === 'string' && search.provider.trim() ? search.provider.trim() : undefined,
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
  | { provider: ModelProviderView; model: string; status: 'error'; message: string; requestLogId?: string; testInput?: SystemOneTestInput; elapsedSeconds: number };

const CHAT_PROVIDER_TEST_PROMPT = '\u4f60\u597d';
const SYSTEM_ONE_TEST_INPUT: SystemOneTestInput = {
  state: { message: 'WorkLite provider connection test' },
  questions: { connection: { type: 'noul', instructions: 'Does `message` contain text?' } },
};
const PROVIDER_TEST_MODEL_KEY = 'worklite.provider-test-model.';

function formatTestValue(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? '';
}

function parseHeaders(value: string): Record<string, string> | undefined {
  if (!value.trim()) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((item) => typeof item !== 'string')) throw new Error('invalid');
  const headers = Object.fromEntries(Object.entries(parsed).map(([headerName, headerValue]) => [headerName.trim(), headerValue])) as Record<string, string>;
  if (Object.keys(headers).some((headerName) => !headerName)) throw new Error('invalid');
  return headers;
}

type ModelListProps = {
  id: string;
  value: string[];
  onChange: (value: string[]) => void;
  removeLabel: (model: string) => string;
  editLabel: (model: string) => string;
  addPlaceholder: string;
  emptyLabel: string;
  disabled?: boolean;
};

function ModelList({ id, value, onChange, removeLabel, editLabel, addPlaceholder, emptyLabel, disabled = false }: ModelListProps) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  function moveModel(targetIndex: number) {
    if (draggedIndex === null || draggedIndex === targetIndex) return;
    const next = [...value];
    const [moved] = next.splice(draggedIndex, 1);
    if (moved) next.splice(targetIndex, 0, moved);
    onChange(next);
    setDraggedIndex(null);
  }
  function addModel() {
    const model = draft.trim();
    // An empty or duplicate entry is dropped so the list stays de-duplicated and
    // the field is ready for the next id without reporting a failure.
    if (model && !value.includes(model)) onChange([...value, model]);
    setDraft('');
  }
  function startEditing(index: number) {
    if (disabled) return;
    setEditingIndex(index);
    setEditDraft(value[index] ?? '');
  }
  function commitEditing(index: number) {
    const model = editDraft.trim();
    const current = value[index];
    // Clearing the text or reusing another id cancels the edit: removal has its own
    // control, and a silent merge would drop a row the user did not ask to remove.
    if (model && model !== current && !value.includes(model)) onChange(value.map((item, itemIndex) => itemIndex === index ? model : item));
    setEditingIndex(null);
    setEditDraft('');
  }
  function cancelEditing() {
    setEditingIndex(null);
    setEditDraft('');
  }
  return (
    <div id={id} className="grid gap-2 rounded-xl border border-border bg-surface p-2 shadow-xs" aria-label="模型列表">
      <Input
        autoComplete="off"
        className="font-mono text-[13px]"
        placeholder={addPlaceholder}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={addModel}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          // The dialog's default submit would save the provider instead of
          // committing the id being typed.
          event.preventDefault();
          addModel();
        }}
      />
      {value.length === 0 ? <p className="px-2 py-3 text-sm text-muted-foreground">{emptyLabel}</p> : value.map((model, index) => (
        <div key={model} draggable={!disabled && editingIndex !== index} onDragStart={() => setDraggedIndex(index)} onDragOver={(event) => event.preventDefault()} onDrop={() => moveModel(index)} onDragEnd={() => setDraggedIndex(null)} className={`flex items-center gap-2 rounded-md border px-2.5 py-2 ${draggedIndex === index ? 'border-brand bg-brand-subtle' : 'border-border bg-surface-subtle'}`}>
          <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden="true" />
          {editingIndex === index ? (
            <Input
              autoComplete="off"
              // Focus follows the activation that opened this field, so the row the user just chose to
              // edit is the one receiving input. This is not a page-load focus steal.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              aria-label={editLabel(model)}
              className="h-7 min-w-0 flex-1 font-mono text-sm"
              value={editDraft}
              onChange={(event) => setEditDraft(event.target.value)}
              onBlur={() => commitEditing(index)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitEditing(index);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelEditing();
                }
              }}
            />
          ) : (
            // A real button rather than a clickable span so the edit affordance is
            // reachable by keyboard and announced to assistive technology.
            <button type="button" aria-label={editLabel(model)} className="min-w-0 flex-1 truncate rounded-sm text-left font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40" onClick={() => startEditing(index)} disabled={disabled}>
              {model}
            </button>
          )}
          <button type="button" className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40" aria-label={removeLabel(model)} onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))} disabled={disabled}>
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}


function ModelProvidersPage() {
  const { t } = useTranslation(['settings', 'common']);
  const { locale } = useLocale();
  const workspaceSlug = 'personal';
  const { provider: requestedProvider } = Route.useSearch();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [testDialog, setTestDialog] = useState<ProviderTestDialog | null>(null);
  const [providerActivity, setProviderActivity] = useState<ProviderActivity | null>(null);
  const [providerActivityTab, setProviderActivityTab] = useState<'statistics' | 'requests'>('statistics');
  const [dialog, setDialog] = useState<ProviderDialog | null>(null);
  const [codexPoolOpen, setCodexPoolOpen] = useState(false);
  const [deleteProvider, setDeleteProvider] = useState<ModelProviderView | null>(null);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [protocol, setProtocol] = useState<ModelProviderProtocol | ''>('');
  const [baseURL, setBaseURL] = useState('');
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [headersError, setHeadersError] = useState('');
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState('');
  const [protocolError, setProtocolError] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const { data: modelProviders = [], isLoading, isError, refetch } = useModelProvidersQuery(workspaceSlug);
  const gatewayQuery = usePortkeyGatewayQuery();
  const codexAuthQuery = useCodexAuthQuery();
  const codexUsageQuery = useCodexAccountUsagesQuery(codexPoolOpen);
  const [codexAuthBusy, setCodexAuthBusy] = useState(false);
  const [busyCodexAccountIds, setBusyCodexAccountIds] = useState<Set<string>>(() => new Set());
  const [codexAccountErrors, setCodexAccountErrors] = useState<Record<string, string>>({});
  const codexImportRef = useRef<HTMLInputElement>(null);
  const items = useMemo(
    () => modelProviders.filter((provider) => `${provider.name} ${provider.models.join(' ')}`.toLowerCase().includes(search.toLowerCase())),
    [modelProviders, search],
  );

  const codexAccountState = codexAuthQuery.data?.accounts.map((account) => `${account.id}:${account.enabled}`).join('|') ?? '';

  const openProviderActivity = useCallback((provider: ModelProviderView) => {
    const to = new Date().toISOString();
    setProviderActivity({ provider, from: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(), to });
    setProviderActivityTab('statistics');
  }, []);

  useEffect(() => {
    if (!requestedProvider || isLoading || isError) return;
    const provider = modelProviders.find((item) => item.name === requestedProvider);
    if (provider) openProviderActivity(provider);
    void navigate({ to: '/model-providers', search: () => ({ provider: undefined }), replace: true });
  }, [requestedProvider, isLoading, isError, modelProviders, navigate, openProviderActivity]);

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
    setBusyCodexAccountIds((current) => new Set(current).add(accountId));
    setCodexAccountErrors((current) => ({ ...current, [accountId]: '' }));
    try { await api.updateCodexAccount(accountId, enabled); await codexAuthQuery.refetch(); await codexUsageQuery.refetch(); await queryClient.invalidateQueries({ queryKey: ['model-providers'] }); }
    catch (error) { setCodexAccountErrors((current) => ({ ...current, [accountId]: error instanceof Error ? error.message : t('providers.gateway.codex.updateFailed') })); }
    finally { setBusyCodexAccountIds((current) => { const next = new Set(current); next.delete(accountId); return next; }); }
  }

  async function refreshCodexAccount(accountId: string) {
    setBusyCodexAccountIds((current) => new Set(current).add(accountId));
    setCodexAccountErrors((current) => ({ ...current, [accountId]: '' }));
    try { await api.refreshCodexAccount(accountId); await codexAuthQuery.refetch(); await codexUsageQuery.refetch(); toast.success(t('providers.gateway.codex.refreshed')); }
    catch (error) { setCodexAccountErrors((current) => ({ ...current, [accountId]: error instanceof Error ? error.message : t('providers.gateway.codex.refreshFailed') })); }
    finally { setBusyCodexAccountIds((current) => { const next = new Set(current); next.delete(accountId); return next; }); }
  }

  async function deleteCodexAccount(accountId: string) {
    setBusyCodexAccountIds((current) => new Set(current).add(accountId));
    setCodexAccountErrors((current) => ({ ...current, [accountId]: '' }));
    try { await api.deleteCodexAccount(accountId); await codexAuthQuery.refetch(); await codexUsageQuery.refetch(); await queryClient.invalidateQueries({ queryKey: ['model-providers'] }); toast.success(t('providers.gateway.codex.removed')); }
    catch (error) { setCodexAccountErrors((current) => ({ ...current, [accountId]: error instanceof Error ? error.message : t('providers.gateway.codex.removeFailed') })); }
    finally { setBusyCodexAccountIds((current) => { const next = new Set(current); next.delete(accountId); return next; }); }
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
    setProtocol('');
    setBaseURL('');
    setModelIds([]);
    setModelsError('');
    setHeadersText('');
    setHeadersError('');
    setProviderError('');
    setProtocolError('');
    setDialog({ mode: 'create' });
  }

  function openEdit(provider: ModelProviderView) {
    setName(provider.name);
    setApiKey(provider.apiKey);
    setProtocol(provider.protocol);
    setBaseURL(provider.baseURL ?? '');
    setModelIds(provider.models);
    setModelsError('');
    setHeadersText('');
    setHeadersError('');
    setProviderError('');
    setProtocolError('');
    setDialog({ mode: 'edit', provider });
  }

  function closeProviderDialog() {
    setDialog(null);
    setApiKey('');
    setModelsError('');
    setHeadersError('');
    setProviderError('');
    setProtocolError('');
  }

  async function saveProvider() {
    if (!dialog || (dialog.mode === 'create' && !name.trim())) return;
    const selectedProtocol = protocol;
    if (!selectedProtocol) {
      setProtocolError(t('providers.protocolRequired'));
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
    const mode = dialog.mode;
    setProviderBusy(true);
    setProviderError('');
    try {
      if (dialog.mode === 'create') {
        await api.saveModelProvider(workspaceSlug, { name: name.trim(), protocol: selectedProtocol, apiKey: apiKey.trim() || undefined, baseURL: baseURL.trim() || undefined, models: modelIds, ...(headers !== undefined ? { headers } : {}) });
      } else {
        await api.updateModelProvider(workspaceSlug, dialog.provider.id, { name: name.trim(), protocol: selectedProtocol, apiKey: apiKey.trim() || undefined, baseURL: baseURL.trim() || undefined, models: modelIds, ...(headers !== undefined ? { headers } : {}) });
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
    const selectedProtocol = protocol;
    if (!selectedProtocol) {
      setProtocolError(t('providers.protocolRequired'));
      return;
    }
    if (selectedProtocol !== 'codex/responses' && !apiKey.trim()) {
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
      const input: DiscoverModelProviderRequest = { protocol: selectedProtocol, apiKey: apiKey.trim(), baseURL: baseURL.trim() || undefined, ...(headers !== undefined ? { headers } : {}) };
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
        queryClient.invalidateQueries({ queryKey: ['agent', CHAT_AGENT_ID] }),
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

  function startProviderTest(provider: ModelProviderView, model: string) {
    window.localStorage.setItem(`${PROVIDER_TEST_MODEL_KEY}${provider.id}`, model);
    const startedAt = currentTime();
    setTestDialog({ provider, model, status: 'loading', startedAt, elapsedSeconds: 0 });
    void api.testModelProvider(workspaceSlug, provider.id, { model }).then((result) => {
      setTestDialog((current) => current?.provider.id === provider.id ? { provider, model, status: 'success', result, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1_000) } : current);
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : t('providers.testFailed');
      const requestLogId = error instanceof Error && 'requestLogId' in error && typeof error.requestLogId === 'string' ? error.requestLogId : undefined;
      const testInput = provider.protocol === 'typesafe/systemone'
        ? error instanceof ApiError && error.testInput ? error.testInput : SYSTEM_ONE_TEST_INPUT
        : undefined;
      setTestDialog((current) => current?.provider.id === provider.id ? { provider, model, status: 'error', message, requestLogId, testInput, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1_000) } : current);
    });
  }

  function runProviderTest() {
    if (!testDialog || !testDialog.model || testDialog.status === 'loading') return;
    startProviderTest(testDialog.provider, testDialog.model);
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
      <WorkspaceChrome crumbs={[{ label: t('providers.title') }]} />
      <PageHeading title={t('providers.title')} description={t('providers.description')} />
      <WebSearchSettings />
      <GatewayPanel
        gateway={gatewayQuery.data}
        providers={modelProviders}
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
            <Button onClick={openCreate}>
              <Plus className="size-4" />
              {t('providers.create')}
            </Button>
          }
        />
        <div className="mt-4">
          {isLoading ? <CollectionLoading label={t('providers.loading')} rows={4} columns={[t('providers.columns.provider'), t('providers.columns.status'), t('providers.columns.models'), t('providers.columns.credential'), t('providers.columns.actions')]} headerClassName="min-w-[900px] [&>span]:whitespace-nowrap" rowClassName="min-w-[900px] [&>span]:whitespace-nowrap" /> : isError ? <ErrorState title={t('providers.title')} description={t('providers.loadFailed')} onAction={() => void refetch()} /> : modelProviders.length === 0 ? (
            <EmptyState title={t('providers.empty.title')} description={t('providers.empty.description')} actionLabel={t('providers.create')} onAction={openCreate} />
          ) : items.length === 0 ? (
            <EmptyState title={t('providers.noMatches.title')} description={t('providers.noMatches.description')} actionLabel={t('common:actions.clearFilters')} onAction={() => setSearch('')} />
          ) : (
            <CollectionTable>
              <CollectionHeader className="min-w-[900px] [&>span]:whitespace-nowrap" columns={[t('providers.columns.provider'), t('providers.columns.status'), t('providers.columns.models'), t('providers.columns.credential'), t('providers.columns.actions')]} />
              {items.map((provider) => (
                <CollectionRow key={provider.id} className="min-w-[900px] [&>span]:whitespace-nowrap">
                  <button type="button" onClick={() => openProviderActivity(provider)} aria-label={t('providers.openActivity', { provider: provider.name })} className="flex min-w-0 items-center gap-2 rounded-sm text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45">
                    <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 truncate"><span className="block truncate">{provider.name}</span><span className="block text-xs font-normal text-muted-foreground">{provider.protocol}</span></span>
                  </button>
                  {provider.status === 'connected' ? <span className="text-xs text-muted-foreground">{t('providers.configured')}</span> : <StatusBadge status={provider.status} />}
                  <span className="truncate text-[13px] text-muted-foreground">{formatList(provider.models, locale) || t('common:empty.dash')}</span>
                  <span className="min-w-0 text-[13px] text-muted-foreground"><span className="block font-mono">{provider.maskedKey || t('common:empty.dash')}</span>{provider.headerNames.length ? <span className="block truncate">{t('providers.headerNames', { names: provider.headerNames.join(', ') })}</span> : null}</span>
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="secondary" size="compact" onClick={() => openProviderTest(provider)} disabled={testDialog?.status === 'loading' && testDialog.provider.id === provider.id}>
                      {testDialog?.status === 'loading' && testDialog.provider.id === provider.id ? t('providers.testing') : t('providers.test')}
                    </Button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-compact" aria-label={t('providers.edit')} onClick={() => isBuiltInCodexProvider(provider) ? setCodexPoolOpen(true) : openEdit(provider)}><Pencil /></Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('providers.edit')}</TooltipContent>
                    </Tooltip>
                    {isBuiltInCodexProvider(provider) ? null : <Tooltip>
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

      <Dialog open={codexPoolOpen} onOpenChange={setCodexPoolOpen}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('providers.codexPool.dialogTitle')}</DialogTitle>
            <DialogDescription>{t('providers.codexPool.dialogDescription')}</DialogDescription>
          </DialogHeader>
          <CodexAccountPool auth={codexAuthQuery.data} usage={codexUsageQuery.data} usageLoading={codexUsageQuery.isLoading} usageError={codexUsageQuery.isError} authBusy={codexAuthBusy} busyAccountIds={busyCodexAccountIds} accountErrors={codexAccountErrors} onLogin={() => void startCodexAuth()} importRef={codexImportRef} onImport={(file) => void importCodexAccounts(file)} onToggleAccount={(accountId, enabled) => void setCodexAccountEnabled(accountId, enabled)} onRefreshAccount={(accountId) => void refreshCodexAccount(accountId)} onDeleteAccount={(accountId) => void deleteCodexAccount(accountId)} locale={locale} t={(key) => t(key as never)} />
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(providerActivity)} onOpenChange={(open) => !open && setProviderActivity(null)}>
        <DialogContent className="max-h-[90vh] max-w-6xl overflow-y-auto">
          <DialogHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <DialogTitle>{providerActivity?.provider.name}</DialogTitle>
                <DialogDescription>{providerActivity?.provider.protocol} · {t('providers.activity.last24h')}</DialogDescription>
              </div>
              {providerActivity ? <div className="flex items-center gap-2">{providerActivity.provider.status === 'connected' ? <span className="text-xs text-muted-foreground">{t('providers.configured')}</span> : <StatusBadge status={providerActivity.provider.status} />}<Button type="button" variant="secondary" size="compact" onClick={() => { const provider = providerActivity.provider; setProviderActivity(null); if (isBuiltInCodexProvider(provider)) setCodexPoolOpen(true); else openEdit(provider); }}><Pencil className="size-4" aria-hidden="true" />{t('providers.edit')}</Button></div> : null}
            </div>
          </DialogHeader>
          {providerActivity ? <>
            {providerActivity.provider.models.length ? <div className="flex flex-wrap gap-1.5" aria-label={t('providers.models')}>
              {providerActivity.provider.models.map((model) => <span key={model} className="max-w-full truncate rounded-md border border-border bg-surface-subtle px-2 py-1 font-mono text-xs">{model}</span>)}
            </div> : null}
            <Tabs value={providerActivityTab} onValueChange={(value) => { if (value === 'statistics' || value === 'requests') setProviderActivityTab(value); }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <TabsList variant="segmented">
                  <TabsTrigger variant="segmented" value="statistics"><BarChart3 className="size-4" aria-hidden="true" />{t('providers.activity.statistics')}</TabsTrigger>
                  <TabsTrigger variant="segmented" value="requests"><ScrollText className="size-4" aria-hidden="true" />{t('providers.activity.requests')}</TabsTrigger>
                </TabsList>
                <Button type="button" variant="ghost" size="compact" onClick={() => {
                  const activity = providerActivity;
                  setProviderActivity(null);
                  void navigate({ to: '/logs', search: { tab: 'statistics', from: activity.from, to: activity.to, provider: activity.provider.name, model: activity.model } });
                }}>{t('providers.activity.openLogs')}</Button>
              </div>
              <TabsContent value="statistics">
                <GatewayStatistics
                  from={providerActivity.from}
                  to={providerActivity.to}
                  filters={{ provider: providerActivity.provider.name }}
                  onViewRequests={(_, model) => { setProviderActivity((current) => current ? { ...current, model } : current); setProviderActivityTab('requests'); }}
                />
              </TabsContent>
              <TabsContent value="requests">
                <GatewayRequestLogs
                  from={providerActivity.from}
                  to={providerActivity.to}
                  providers={[providerActivity.provider]}
                  filters={{ provider: providerActivity.provider.name, model: providerActivity.model, statusClass: providerActivity.statusClass }}
                  onFiltersChange={(next: RequestLogFilters) => setProviderActivity((current) => current ? { ...current, model: next.model, statusClass: next.statusClass } : current)}
                  lockProvider
                />
              </TabsContent>
            </Tabs>
          </> : null}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(dialog)} onOpenChange={(open) => !open && closeProviderDialog()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t(dialog?.mode === 'edit' ? 'providers.editTitle' : 'providers.createTitle')}</DialogTitle>
            <DialogDescription>{t(dialog?.mode === 'edit' ? 'providers.editDescription' : 'providers.createDescription')}</DialogDescription>
          </DialogHeader>
          {providerError ? <p className="text-[13px] text-danger" role="alert">{providerError}</p> : null}
          <Field label={t('providers.name')} htmlFor="provider-name"><Input id="provider-name" autoComplete="off" placeholder={t('providers.namePlaceholder')} value={name} onChange={(event) => setName(event.target.value)} disabled={providerBusy} /></Field>
          <Field label={t('providers.baseURL')} htmlFor="provider-base-url" hint={t('providers.baseURLHint')}><Input id="provider-base-url" autoComplete="off" placeholder={t('providers.baseURLPlaceholder')} value={baseURL} onChange={(event) => setBaseURL(event.target.value)} /></Field>
          <Field label={t('providers.protocol')} htmlFor="provider-protocol" error={protocolError}>
            <Select value={protocol || undefined} onValueChange={(value) => { setProtocol(value as ModelProviderProtocol); setProtocolError(''); }}>
              <SelectTrigger id="provider-protocol" aria-invalid={Boolean(protocolError)}><SelectValue placeholder={t('providers.protocolPlaceholder')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="openai/chat">openai/chat</SelectItem>
                <SelectItem value="openai/responses">openai/responses</SelectItem>
                <SelectItem value="anthropic/messages">anthropic/messages</SelectItem>
                <SelectItem value="typesafe/systemone">typesafe/systemone</SelectItem>
                {dialog?.mode === 'edit' && protocol === 'codex/responses' ? <SelectItem value="codex/responses">codex/responses</SelectItem> : null}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('providers.apiKey')} htmlFor="provider-api-key">
            <PasswordInput id="provider-api-key" autoComplete="off" placeholder={t('providers.secretPlaceholder')} value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          </Field>
          <Field label={t('providers.models')} htmlFor="provider-models" hint={t('providers.modelsHint')} error={modelsError}>
            <div className="flex flex-col gap-2">
              <ModelList id="provider-models" value={modelIds} onChange={(value) => { setModelIds(value); setModelsError(''); }} removeLabel={(model) => t('providers.removeModel', { model })} editLabel={(model) => t('providers.editModel', { model })} addPlaceholder={t('providers.addModelPlaceholder')} emptyLabel={t('providers.emptyModels')} disabled={providerBusy || modelsBusy} />
              <div className="flex items-center justify-between gap-3">
                <Button variant="secondary" size="compact" onClick={() => void discoverModels()} disabled={providerBusy || modelsBusy || protocol === 'typesafe/systemone' || (protocol !== 'codex/responses' && !apiKey.trim())}>
                  {modelsBusy ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <RefreshCw className="size-4" aria-hidden="true" />}
                  {modelsBusy ? t('providers.fetchingModels') : t('providers.fetchModels')}
                </Button>
                <span className="text-xs tabular-nums text-muted-foreground">{t('providers.modelCount', { count: modelIds.length })}</span>
              </div>
            </div>
          </Field>
          <Field label={t('providers.headers')} htmlFor="provider-headers" hint={t('providers.headersHint')} error={headersError}><Textarea id="provider-headers" autoComplete="off" className="min-h-28 font-mono text-[13px]" placeholder={t('providers.headersPlaceholder')} value={headersText} aria-invalid={Boolean(headersError)} onChange={(event) => { setHeadersText(event.target.value); setHeadersError(''); }} /></Field>
          <DialogFooter>
            {dialog?.mode === 'edit' && protocol === 'codex/responses' ? <Button variant="secondary" className="sm:mr-auto" onClick={() => { closeProviderDialog(); setCodexPoolOpen(true); }} disabled={providerBusy}>{t('providers.codexPool.manage')}</Button> : null}
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
              {testDialog?.provider.protocol === 'typesafe/systemone'
                ? t('providers.testDescriptionSystemOne')
                : testDialog?.status === 'success' && testDialog.result.protocol !== 'typesafe/systemone'
                  ? t('providers.testDescriptionWithModel', { model: testDialog.result.model })
                  : t('providers.testDescription')}
            </DialogDescription>
          </DialogHeader>
          <Field label={t('providers.testModel')} htmlFor="provider-test-model">
            <Select value={testDialog?.model ?? ''} onValueChange={selectTestModel} disabled={testDialog?.status === 'loading'}>
              <SelectTrigger id="provider-test-model"><SelectValue placeholder={t('providers.testModelPlaceholder')} /></SelectTrigger>
              <SelectContent>{testDialog?.provider.models.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {testDialog && testDialog.status !== 'idle' ? testDialog.provider.protocol === 'typesafe/systemone' ? <div className="flex min-h-52 flex-col gap-4 py-2">
            <div className="rounded-md border border-border bg-surface-subtle px-4 py-3 text-sm">
              <p className="text-xs font-medium text-muted-foreground">{t('providers.testInputLabel')}</p>
              <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{formatTestValue(testDialog.status === 'success' && testDialog.result.protocol === 'typesafe/systemone' ? testDialog.result.input : testDialog.status === 'error' && testDialog.testInput ? testDialog.testInput : SYSTEM_ONE_TEST_INPUT)}</pre>
            </div>
            <div className="rounded-md border border-border bg-surface-subtle px-4 py-3 text-sm">
              <p className="text-xs font-medium text-muted-foreground">{t('providers.testOutputLabel')}</p>
              {testDialog.status === 'loading' ? (
                <div className="mt-3 flex items-center gap-2 text-muted-foreground"><LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /><span className="sr-only">{t('providers.waitingReplyAccessible')}</span><span aria-hidden="true" className="tabular-nums">{t('providers.waitingReply', { seconds: testDialog.elapsedSeconds })}</span></div>
              ) : testDialog.status === 'success' ? (
                <div aria-live="polite"><pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{formatTestValue(testDialog.result.protocol === 'typesafe/systemone' ? testDialog.result.output : {})}</pre><p className="mt-3 border-t border-border pt-2 text-xs tabular-nums text-muted-foreground">{t('providers.testDuration', { seconds: testDialog.elapsedSeconds })}</p></div>
                ) : (
                  <><p role="alert" className="mt-3 break-words text-danger">{testDialog.message}</p>{testDialog.requestLogId ? <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2"><Button type="button" variant="ghost" size="compact" onClick={() => { const provider = testDialog.provider.name; const model = testDialog.model; const requestLogId = testDialog.requestLogId; setTestDialog(null); void navigate({ to: '/logs', search: { tab: 'requests', range: '24h', provider, model, requestLogId } }); }}>{t('providers.viewRequestLog')}</Button></div> : null}<p className="mt-3 border-t border-border pt-2 text-xs tabular-nums text-muted-foreground">{t('providers.testDuration', { seconds: testDialog.elapsedSeconds })}</p></>
              )}
            </div>
          </div> : <div className="flex min-h-52 flex-col gap-5 py-2">
            <div className="flex justify-end">
              <div className="wl-enter max-w-[80%] rounded-2xl rounded-br-md bg-brand-subtle px-4 py-3 text-sm text-foreground">
                <p className="sr-only">{t('providers.testPromptLabel')}</p>
                <p className="whitespace-pre-wrap">{testDialog.status === 'success' && testDialog.result.protocol !== 'typesafe/systemone' ? testDialog.result.prompt : CHAT_PROVIDER_TEST_PROMPT}</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-brand shadow-xs" aria-hidden="true"><Bot className="size-4" /></div>
              <div className="wl-enter min-w-0 flex-1 rounded-2xl rounded-tl-md border border-border bg-surface-subtle px-4 py-3 text-sm">
                <p className="sr-only">{t('providers.testReplyLabel')}</p>
                {testDialog.status === 'loading' ? (
                  <div className="flex items-center gap-2 text-muted-foreground"><LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /><span className="sr-only">{t('providers.waitingReplyAccessible')}</span><span aria-hidden="true" className="tabular-nums">{t('providers.waitingReply', { seconds: testDialog.elapsedSeconds })}</span></div>
                ) : testDialog.status === 'success' ? (
                  <div aria-live="polite"><p className="whitespace-pre-wrap break-words">{testDialog.result.protocol === 'typesafe/systemone' ? '' : testDialog.result.response}</p><p className="mt-3 border-t border-border pt-2 text-xs tabular-nums text-muted-foreground">{t('providers.testDuration', { seconds: testDialog.elapsedSeconds })}</p></div>
                ) : (
                  <><p role="alert" className="break-words text-danger">{testDialog.message}</p>{testDialog.requestLogId ? <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2"><Button type="button" variant="ghost" size="compact" onClick={() => { const provider = testDialog.provider.name; const model = testDialog.model; const requestLogId = testDialog.requestLogId; setTestDialog(null); void navigate({ to: '/logs', search: { tab: 'requests', range: '24h', provider, model, requestLogId } }); }}>{t('providers.viewRequestLog')}</Button></div> : null}<p className="mt-3 border-t border-border pt-2 text-xs tabular-nums text-muted-foreground">{t('providers.testDuration', { seconds: testDialog.elapsedSeconds })}</p></>
                )}
              </div>
            </div>
          </div> : null}
          <DialogFooter><Button variant="secondary" onClick={() => setTestDialog(null)}>{t('common:actions.close')}</Button><Button onClick={runProviderTest} disabled={!testDialog?.model || testDialog?.status === 'loading'}>{testDialog?.status === 'loading' ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}{t('providers.runTest')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteProvider)}
        onOpenChange={(nextOpen) => { if (!nextOpen) { setDeleteProvider(null); setDeleteError(''); } }}
        title={t('providers.deleteTitle', { provider: deleteProvider?.name })}
        description={t('providers.deleteDescription')}
        confirmLabel={t('providers.deleteAction')}
        cancelLabel={t('common:actions.cancel')}
        busyLabel={t('providers.deleteAction')}
        error={deleteError}
        busy={deleteBusy}
        onConfirm={() => void removeProvider()}
      />
    </div>
  );
}

function GatewayPanel({ gateway, providers, t }: { gateway?: { port: number; host: string; status: PortkeyGatewayStatus; error: string | null }; providers: ModelProviderView[]; t: (key: string, options?: Record<string, unknown>) => string }) {
  const status = gateway?.status ?? 'starting';
  const running = status === 'running';
  const publicBaseUrl = `${typeof window === 'undefined' ? '' : window.location.origin}/api/portkey-gateway/v1`;
  const namespacedModels = providers.flatMap((provider) => provider.models.map((model) => `${provider.name}/${model}`));
  const exampleModel = namespacedModels[0] ?? '<providerName>/<modelId>';
  const configExample = JSON.stringify({ base_url: publicBaseUrl, api_key: 'not-required', model: exampleModel }, null, 2);
  async function copyValue(value: string) { if (!navigator.clipboard) return; await navigator.clipboard.writeText(value); toast.success(t('providers.gateway.copied')); }
  return <section className="mt-6 w-full rounded-xl border border-border bg-surface p-4 shadow-xs">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-base font-semibold">{t('providers.gateway.title')}</h2><p className="mt-1 text-[13px] text-muted-foreground">{t('providers.gateway.description')}</p></div><div className="shrink-0"><p className="text-xs font-medium text-muted-foreground">{t('providers.gateway.status')}</p><div className="mt-1"><StatusBadge status={running ? 'gateway_running' : status} /></div></div></div>
    <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground"><span><span className="font-medium">{t('providers.gateway.port')}:</span> <code className="font-mono text-foreground">{gateway?.port ?? 23392}</code></span><span className="font-mono">{gateway ? `http://${gateway.host}:${gateway.port}` : t('providers.gateway.loading')}</span></div>
    {gateway?.error ? <p className="text-[13px] text-danger" role="alert">{gateway.error}</p> : null}
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
  busyAccountIds: Set<string>;
  accountErrors: Record<string, string>;
  onLogin: () => void;
  importRef: RefObject<HTMLInputElement | null>;
  onImport: (file: File) => void;
  onToggleAccount: (accountId: string, enabled: boolean) => void;
  onRefreshAccount: (accountId: string) => void;
  onDeleteAccount: (accountId: string) => void;
  locale: AppLocale;
  t: (key: string, options?: Record<string, unknown>) => string;
};

function CodexAccountPool({ auth, usage, usageLoading, usageError, authBusy, busyAccountIds, accountErrors, onLogin, importRef, onImport, onToggleAccount, onRefreshAccount, onDeleteAccount, locale, t }: CodexAccountPoolProps) {
  const usageByAccountId = new Map((usage?.accounts ?? []).map((item) => [item.accountId, item]));
  const accounts = auth?.accounts ?? [];
  const enabledAccounts = accounts.filter((account) => account.enabled).length;
  const authStatus = auth?.status === 'connected' ? 'connected' : auth?.status === 'login_pending' ? 'pending' : auth?.status === 'error' ? 'invalid' : 'unconfigured';
  return <section className="space-y-5" aria-label={t('providers.codexPool.title')}>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-muted-foreground">
        <StatusBadge status={authStatus} />
        <span>{t('providers.codexPool.authMethod')}: {auth?.authMethod === 'oauth' ? t('providers.codexPool.oauth') : auth?.authMethod === 'environment' ? t('providers.codexPool.environment') : t('common:empty.dash')}</span>
        <span>{t('providers.codexPool.enabledAccounts', { enabled: enabledAccounts, total: accounts.length })}</span>
      </div></div>
      <div className="flex flex-wrap gap-2">
        <Button size="compact" onClick={onLogin} disabled={authBusy}><LogIn className="size-4" />{auth?.status === 'login_pending' ? t('providers.gateway.codex.loginPending') : t('providers.gateway.codex.addAccount')}</Button>
        <input ref={importRef} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); }} />
        <Button variant="secondary" size="compact" onClick={() => importRef.current?.click()} disabled={authBusy}><Upload className="size-4" />{t('providers.gateway.codex.import')}</Button>
      </div>
    </div>
    {auth?.error ? <p className="text-[13px] text-danger" role="alert">{auth.error}</p> : null}
    {usageError ? <p className="text-[13px] text-danger" role="alert">{t('providers.codexPool.usageError')}</p> : null}
    {usageLoading && accounts.length > 0 ? <p className="text-sm text-muted-foreground" role="status">{t('providers.codexPool.loading')}</p> : null}
    {accounts.length === 0 ? <EmptyState title={t('providers.codexPool.emptyTitle')} description={t('providers.codexPool.emptyDescription')} /> : <div className="grid gap-4 xl:grid-cols-2">
      {accounts.map((account) => {
        const accountUsage = usageByAccountId.get(account.id);
        return <CodexAccountCard key={account.id} account={account} usage={accountUsage} authBusy={authBusy} accountBusy={busyAccountIds.has(account.id)} actionError={accountErrors[account.id]} locale={locale} t={t} onToggle={onToggleAccount} onRefresh={onRefreshAccount} onDelete={onDeleteAccount} />;
      })}
    </div>}
    {usage?.fetchedAt ? <p className="text-xs text-muted-foreground">{t('providers.codexPool.fetchedAt')}: {formatDateTime(usage.fetchedAt, locale)}</p> : null}
  </section>;
}

function CodexAccountCard({ account, usage, authBusy, accountBusy, actionError, locale, t, onToggle, onRefresh, onDelete }: { account: CodexAuthStatus['accounts'][number]; usage?: CodexAccountUsageSnapshot['accounts'][number]; authBusy: boolean; accountBusy: boolean; actionError?: string; locale: AppLocale; t: (key: string, options?: Record<string, unknown>) => string; onToggle: (accountId: string, enabled: boolean) => void; onRefresh: (accountId: string) => void; onDelete: (accountId: string) => void }) {
  const status = usage?.status ?? account.status;
  const statusBadge = status === 'disabled' ? 'disabled' : status === 'expired' ? 'invalid' : status === 'error' ? 'error' : status === 'unavailable' ? 'missing' : status === 'connected' ? 'connected' : 'unconfigured';
  const accountLabel = account.email || account.name;
  const identity = account.accountId || account.id;
  return <article className="rounded-xl border border-border bg-surface p-4 shadow-xs">
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
    {actionError ? <p className="mt-3 text-xs text-danger" role="alert">{actionError}</p> : null}
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <CodexQuotaWindow title={t('providers.codexPool.primary')} window={usage?.primary ?? null} locale={locale} t={t} />
      <CodexQuotaWindow title={t('providers.codexPool.secondary')} window={usage?.secondary ?? null} locale={locale} t={t} />
    </div>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
      <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{accountBusy ? t('providers.gateway.codex.updating') : account.enabled ? t('providers.gateway.codex.enabled') : t('providers.gateway.codex.disabled')}</span><Switch checked={account.enabled} disabled={authBusy || accountBusy} aria-label={`${account.enabled ? t('providers.gateway.codex.disable') : t('providers.gateway.codex.enable')} ${accountLabel}`} onCheckedChange={(enabled) => onToggle(account.id, enabled)} /></div>
      <div className="flex items-center gap-1"><Button variant="ghost" size="icon" aria-label={`${t('providers.gateway.codex.refresh')} ${accountLabel}`} onClick={() => onRefresh(account.id)} disabled={authBusy || accountBusy || !account.enabled}>{accountBusy ? <LoaderCircle className="size-4 motion-safe:animate-spin" /> : <RefreshCw className="size-4" />}</Button><Button variant="ghost" size="icon" aria-label={`${t('providers.gateway.codex.remove')} ${accountLabel}`} onClick={() => onDelete(account.id)} disabled={authBusy || accountBusy}><Trash2 className="size-4" /></Button></div>
    </div>
    {usage?.fetchedAt ? <p className="mt-2 text-right text-xs text-muted-foreground">{t('providers.codexPool.fetchedAt')}: {formatDateTime(usage.fetchedAt, locale)}</p> : null}
  </article>;
}

function CodexQuotaWindow({ title, window, locale, t }: { title: string; window: CodexRateLimitWindow | null; locale: AppLocale; t: (key: string, options?: Record<string, unknown>) => string }) {
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

function Detail({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-1 break-words font-mono text-xs">{value}</p></div>;
}

function currentTime(): number {
  return Date.now();
}
