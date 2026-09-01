import { createFileRoute } from '@tanstack/react-router';
import { Bot, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, RotateCcw, Square, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { DiscoverModelProviderRequest, ModelProviderProtocol, ModelProviderTestResult, ModelProviderView, PortkeyGatewayStatus } from '@worklite/contracts';
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
import { useModelProvidersQuery, usePortkeyGatewayQuery } from '@/api/queries';
import { api } from '@/api/client';
import { queryClient } from '@/lib/query-client';
import { formatList } from '@/i18n/format';
import { useLocale } from '@/components/locale-provider';

export const Route = createFileRoute('/model-providers')({
  component: ModelProvidersPage,
});

type ProviderDialog =
  | { mode: 'create' }
  | { mode: 'edit'; provider: ModelProviderView };

type ProviderTestDialog =
  | { provider: ModelProviderView; status: 'loading'; startedAt: number; elapsedSeconds: number }
  | { provider: ModelProviderView; status: 'success'; result: ModelProviderTestResult; elapsedSeconds: number }
  | { provider: ModelProviderView; status: 'error'; message: string; elapsedSeconds: number };

const PROVIDER_TEST_PROMPT = '\u4f60\u597d';

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
      />
    </div>
  );
}

function ModelProvidersPage() {
  const { t } = useTranslation(['settings', 'common']);
  const { locale } = useLocale();
  const workspaceSlug = 'personal';
  const [view, setView] = useState<'providers' | 'gateway'>('providers');
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
  const { data: modelProviders = [], isLoading, isError } = useModelProvidersQuery(workspaceSlug);
  const gatewayQuery = usePortkeyGatewayQuery();
  const [gatewayPort, setGatewayPort] = useState('4547');
  const [gatewayBusy, setGatewayBusy] = useState(false);
  const [gatewayError, setGatewayError] = useState('');
  useEffect(() => {
    if (gatewayQuery.data) setGatewayPort(String(gatewayQuery.data.port));
  }, [gatewayQuery.data]);
  const items = useMemo(
    () => modelProviders.filter((provider) => `${provider.name} ${provider.models.join(' ')}`.toLowerCase().includes(search.toLowerCase())),
    [modelProviders, search],
  );

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
    if (!apiKey.trim()) {
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

  function testProvider(provider: ModelProviderView) {
    const startedAt = currentTime();
    setTestDialog({ provider, status: 'loading', startedAt, elapsedSeconds: 0 });
    void api.testModelProvider(workspaceSlug, provider.id).then((result) => {
      setTestDialog((current) => current?.provider.id === provider.id ? { provider, status: 'success', result, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1_000) } : current);
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : t('providers.testFailed');
      setTestDialog((current) => current?.provider.id === provider.id ? { provider, status: 'error', message, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1_000) } : current);
    });
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
      <WorkspaceChrome crumbs={[{ label: t('providers.title') }]} />
      <PageHeading title={t('providers.title')} description={t('providers.description')} />
      <nav className="mt-6 flex max-w-full items-center gap-1 overflow-x-auto rounded-md bg-surface-subtle p-1" aria-label={t('providers.views.label')}>
        <button type="button" className={`rounded-sm px-3 py-1.5 text-[13px] font-medium ${view === 'providers' ? 'bg-surface text-foreground shadow-sm' : 'text-muted-foreground hover:bg-surface/70 hover:text-foreground'}`} onClick={() => setView('providers')}>{t('providers.views.providers')}</button>
        <button type="button" className={`rounded-sm px-3 py-1.5 text-[13px] font-medium ${view === 'gateway' ? 'bg-surface text-foreground shadow-sm' : 'text-muted-foreground hover:bg-surface/70 hover:text-foreground'}`} onClick={() => setView('gateway')}>{t('providers.views.gateway')}</button>
      </nav>
      {view === 'gateway' ? (
        <GatewayPanel
          gateway={gatewayQuery.data}
          port={gatewayPort}
          busy={gatewayBusy}
          error={gatewayError}
          onPortChange={setGatewayPort}
          onSave={async () => {
            const parsed = Number(gatewayPort);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) { setGatewayError(t('providers.gateway.invalidPort')); return; }
            setGatewayBusy(true); setGatewayError('');
            try { const saved = await api.updatePortkeyGateway({ port: parsed }); queryClient.setQueryData(['portkey-gateway'], saved); toast.success(t('providers.gateway.saved')); } catch (error: unknown) { setGatewayError(error instanceof Error ? error.message : t('providers.gateway.actionFailed')); } finally { setGatewayBusy(false); }
          }}
          onAction={async (action) => {
            setGatewayBusy(true); setGatewayError('');
            try { const result = action === 'start' ? await api.startPortkeyGateway() : action === 'stop' ? await api.stopPortkeyGateway() : await api.restartPortkeyGateway(); queryClient.setQueryData(['portkey-gateway'], result); } catch (error: unknown) { setGatewayError(error instanceof Error ? error.message : t('providers.gateway.actionFailed')); } finally { setGatewayBusy(false); }
          }}
          t={(key) => t(key as never)}
        />
      ) : null}
      {view === 'providers' ? <CollectionToolbar
        className="mt-6"
        search={search}
        onSearchChange={setSearch}
        placeholder={t('providers.search')}
        actions={
          <Button size="compact" onClick={openCreate}>
            <Plus className="size-4" />
            {t('providers.create')}
          </Button>
        }
      /> : null}
      {view === 'providers' ? <div className="mt-4">
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
                  <Button variant="secondary" size="compact" onClick={() => testProvider(provider)} disabled={testDialog?.status === 'loading' && testDialog.provider.id === provider.id}>
                    {testDialog?.status === 'loading' && testDialog.provider.id === provider.id ? t('providers.testing') : t('providers.test')}
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-compact" aria-label={t('providers.edit')} onClick={() => openEdit(provider)}><Pencil /></Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('providers.edit')}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-compact" aria-label={t('providers.delete')} onClick={() => { setDeleteError(''); setDeleteProvider(provider); }}><Trash2 /></Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('providers.delete')}</TooltipContent>
                  </Tooltip>
                </div>
              </CollectionRow>
            ))}
          </CollectionTable>
        )}
      </div> : null}

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
                <Button variant="secondary" size="compact" onClick={() => void discoverModels()} disabled={providerBusy || modelsBusy || !apiKey.trim()}>
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
          <div className="flex min-h-52 flex-col gap-5 py-2">
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
                  <><p role="alert" className="text-danger">{testDialog.message}</p><p className="mt-3 border-t border-border pt-2 text-xs tabular-nums text-muted-foreground">{t('providers.testDuration', { seconds: testDialog.elapsedSeconds })}</p></>
                ) : null}
              </div>
            </div>
          </div>
          <DialogFooter><Button variant="secondary" onClick={() => setTestDialog(null)}>{t('common:actions.close')}</Button></DialogFooter>
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

function GatewayPanel({ gateway, port, busy, error, onPortChange, onSave, onAction, t }: { gateway?: { port: number; host: string; status: PortkeyGatewayStatus; error: string | null }; port: string; busy: boolean; error: string; onPortChange: (value: string) => void; onSave: () => Promise<void>; onAction: (action: 'start' | 'stop' | 'restart') => Promise<void>; t: (key: string) => string }) {
  const status = gateway?.status ?? 'stopped';
  const running = status === 'running';
  return <section className="mt-6 max-w-2xl space-y-6 rounded-lg border border-border bg-surface p-5">
    <div><h2 className="text-base font-semibold">{t('providers.gateway.title')}</h2><p className="mt-1 text-[13px] text-muted-foreground">{t('providers.gateway.description')}</p></div>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t('providers.gateway.port')} htmlFor="portkey-gateway-port"><Input id="portkey-gateway-port" value={port} onChange={(event) => onPortChange(event.target.value)} disabled={busy || running} inputMode="numeric" /></Field>
      <div><p className="text-xs font-medium text-muted-foreground">{t('providers.gateway.status')}</p><div className="mt-2"><StatusBadge status={status} /></div></div>
    </div>
    <p className="font-mono text-xs text-muted-foreground">{gateway ? `http://${gateway.host}:${gateway.port}` : t('providers.gateway.loading')}</p>
    {gateway?.error || error ? <p className="text-[13px] text-danger" role="alert">{error || gateway?.error}</p> : null}
    <div className="flex flex-wrap gap-2"><Button variant="secondary" size="compact" onClick={() => void onSave()} disabled={busy || running}>{t('common:actions.save')}</Button><Button size="compact" onClick={() => void onAction('start')} disabled={busy || running}><Plus className="size-4" />{t('providers.gateway.start')}</Button><Button variant="secondary" size="compact" onClick={() => void onAction('restart')} disabled={busy || !running}><RotateCcw className="size-4" />{t('providers.gateway.restart')}</Button><Button variant="ghost" size="compact" onClick={() => void onAction('stop')} disabled={busy || !running}><Square className="size-4" />{t('providers.gateway.stop')}</Button></div>
  </section>;
}

function currentTime(): number {
  return Date.now();
}
