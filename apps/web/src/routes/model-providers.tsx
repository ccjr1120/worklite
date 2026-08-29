import { createFileRoute } from '@tanstack/react-router';
import { Bot, KeyRound, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ModelProviderTestResult, ModelProviderView } from '@worklite/contracts';
import { AgentResourceNav } from '@/components/agent-resource-nav';
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
import { useModelProvidersQuery } from '@/api/queries';
import { api } from '@/api/client';
import { queryClient } from '@/lib/query-client';
import { formatList } from '@/i18n/format';
import { useLocale } from '@/components/locale-provider';

export const Route = createFileRoute('/model-providers')({
  component: ModelProvidersPage,
});

type ProviderDialog =
  | { mode: 'create' }
  | { mode: 'replace'; provider: ModelProviderView };

type ProviderTestDialog =
  | { provider: ModelProviderView; status: 'loading'; startedAt: number; elapsedSeconds: number }
  | { provider: ModelProviderView; status: 'success'; result: ModelProviderTestResult; elapsedSeconds: number }
  | { provider: ModelProviderView; status: 'error'; message: string; elapsedSeconds: number };

const PROVIDER_TEST_PROMPT = '\u4f60\u597d';

function parseModels(value: string): string[] {
  return value.split(',').map((model) => model.trim()).filter(Boolean);
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
  const [kind, setKind] = useState<'deepseek' | 'openai' | 'openai-compatible'>('openai-compatible');
  const [baseUrl, setBaseUrl] = useState('');
  const [organization, setOrganization] = useState('');
  const [project, setProject] = useState('');
  const [models, setModels] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [headersError, setHeadersError] = useState('');
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const { data: modelProviders = [], isLoading, isError } = useModelProvidersQuery(workspaceSlug);
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
    setKind('openai-compatible');
    setBaseUrl('');
    setOrganization('');
    setProject('');
    setModels('');
    setHeadersText('');
    setHeadersError('');
    setProviderError('');
    setDialog({ mode: 'create' });
  }

  function openReplace(provider: ModelProviderView) {
    setApiKey('');
    setKind(provider.kind);
    setBaseUrl(provider.baseUrl ?? '');
    setOrganization(provider.organization ?? '');
    setProject(provider.project ?? '');
    setModels(provider.models.join(', '));
    setHeadersText('');
    setHeadersError('');
    setProviderError('');
    setDialog({ mode: 'replace', provider });
  }

  function closeProviderDialog() {
    setDialog(null);
    setApiKey('');
    setHeadersError('');
    setProviderError('');
  }

  async function saveProvider() {
    if (!dialog || !apiKey.trim() || (dialog.mode === 'create' && !name.trim())) return;
    let headers: Record<string, string> | undefined;
    if (headersText.trim()) {
      try {
        const parsed: unknown = JSON.parse(headersText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== 'string')) throw new Error('invalid');
        headers = Object.fromEntries(Object.entries(parsed).map(([headerName, value]) => [headerName.trim(), value])) as Record<string, string>;
        if (Object.keys(headers).some((headerName) => !headerName)) throw new Error('invalid');
      } catch {
        setHeadersError(t('providers.headersError'));
        return;
      }
    }
    const providerName = dialog.mode === 'create' ? name.trim() : dialog.provider.name;
    const mode = dialog.mode;
    setProviderBusy(true);
    setProviderError('');
    try {
      await api.saveModelProvider(workspaceSlug, { name: providerName, kind, apiKey: apiKey.trim(), baseUrl: baseUrl.trim() || undefined, organization: organization.trim() || undefined, project: project.trim() || undefined, models: parseModels(models), ...(headers !== undefined ? { headers } : {}) });
      closeProviderDialog();
      toast.success(t(mode === 'create' ? 'providers.created' : 'providers.saved'));
      void queryClient.invalidateQueries({ queryKey: ['model-providers'] }).catch(() => undefined);
    } catch (error: unknown) {
      setProviderError(error instanceof Error ? error.message : t('providers.testFailed'));
    } finally {
      setProviderBusy(false);
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
    const startedAt = Date.now();
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
      <AgentResourceNav workspaceSlug={workspaceSlug} active="providers" />
      <CollectionToolbar
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
                <span className="flex min-w-0 items-center gap-2 font-medium"><KeyRound className="size-4 shrink-0 text-brand" aria-hidden="true" /><span className="min-w-0 truncate"><span className="block truncate">{provider.name}</span><span className="block text-xs font-normal text-muted-foreground">{t(`providers.kinds.${provider.kind === 'openai-compatible' ? 'openaiCompatible' : provider.kind}`)}</span></span></span>
                <StatusBadge status={provider.status} />
                <span className="truncate text-[13px] text-muted-foreground">{formatList(provider.models, locale) || t('common:empty.dash')}</span>
                <span className="min-w-0 text-[13px] text-muted-foreground"><span className="block font-mono">{provider.maskedKey || t('common:empty.dash')}</span><span className="block truncate">{provider.headerNames.length ? t('providers.headerNames', { names: provider.headerNames.join(', ') }) : t('providers.noHeaders')}</span></span>
                <div className="flex items-center justify-end gap-1">
                  <Button variant="secondary" size="compact" onClick={() => testProvider(provider)} disabled={testDialog?.status === 'loading' && testDialog.provider.id === provider.id}>
                    {testDialog?.status === 'loading' && testDialog.provider.id === provider.id ? t('providers.testing') : t('providers.test')}
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-compact" aria-label={t('providers.replaceKey')} onClick={() => openReplace(provider)}><KeyRound /></Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('providers.replaceKey')}</TooltipContent>
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
      </div>

      <Dialog open={Boolean(dialog)} onOpenChange={(open) => !open && closeProviderDialog()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t(dialog?.mode === 'replace' ? 'providers.replaceTitle' : 'providers.createTitle')}</DialogTitle>
            <DialogDescription>{t(dialog?.mode === 'replace' ? 'providers.replaceDescription' : 'providers.createDescription')}</DialogDescription>
          </DialogHeader>
          {providerError ? <p className="text-[13px] text-danger" role="alert">{providerError}</p> : null}
          {dialog?.mode === 'create' ? <Field label={t('providers.name')} htmlFor="provider-name"><Input id="provider-name" placeholder={t('providers.namePlaceholder')} value={name} onChange={(event) => setName(event.target.value)} disabled={providerBusy} /></Field> : null}
          <Field label={t('providers.kind')} htmlFor="provider-kind">
            <Select value={kind} onValueChange={(value) => setKind(value as typeof kind)}>
              <SelectTrigger id="provider-kind"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="deepseek">{t('providers.kinds.deepseek')}</SelectItem>
                <SelectItem value="openai">{t('providers.kinds.openai')}</SelectItem>
                <SelectItem value="openai-compatible">{t('providers.kinds.openaiCompatible')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('providers.apiKey')} htmlFor="provider-api-key">
            <PasswordInput id="provider-api-key" autoComplete="off" placeholder={t('providers.secretPlaceholder')} value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          </Field>
          <Field label={t('providers.baseUrl')} htmlFor="provider-base-url" hint={t('providers.baseUrlHint')}><Input id="provider-base-url" placeholder={t('providers.baseUrlPlaceholder')} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></Field>
          {kind === 'openai' ? <div className="grid gap-4 sm:grid-cols-2"><Field label={t('providers.organization')} htmlFor="provider-organization"><Input id="provider-organization" value={organization} onChange={(event) => setOrganization(event.target.value)} /></Field><Field label={t('providers.project')} htmlFor="provider-project"><Input id="provider-project" value={project} onChange={(event) => setProject(event.target.value)} /></Field></div> : null}
          <Field label={t('providers.models')} htmlFor="provider-models" hint={t('providers.modelsHint')}><Input id="provider-models" placeholder={t('providers.modelsPlaceholder')} value={models} onChange={(event) => setModels(event.target.value)} /></Field>
          <Field label={t('providers.headers')} htmlFor="provider-headers" hint={t('providers.headersHint')} error={headersError}><Textarea id="provider-headers" className="min-h-28 font-mono text-[13px]" placeholder={t('providers.headersPlaceholder')} value={headersText} aria-invalid={Boolean(headersError)} onChange={(event) => { setHeadersText(event.target.value); setHeadersError(''); }} /></Field>
          <DialogFooter>
            <Button variant="secondary" onClick={closeProviderDialog} disabled={providerBusy}>{t('common:actions.cancel')}</Button>
            <Button onClick={() => void saveProvider()} disabled={providerBusy || !apiKey.trim() || (dialog?.mode === 'create' && !name.trim())}>{providerBusy ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}{t(dialog?.mode === 'replace' ? 'providers.replaceAction' : 'providers.createAction')}</Button>
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
