import { useTranslation } from 'react-i18next';
import type { ModelProviderProtocol, ModelProviderView, ProjectExecutor } from '@worklite/contracts';
import { useMcpServersQuery } from '@/api/queries';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';

// Radix Select items cannot use an empty value. Prefix concrete options too, so an arbitrary
// previously-saved native model name can never collide with the default sentinel.
const EXECUTOR_DEFAULT_VALUE = '__worklite_executor_default__';
const EXECUTOR_MODEL_VALUE_PREFIX = 'model:';
const EXECUTOR_CURRENT_VALUE_PREFIX = 'current:';
const EXECUTOR_PROTOCOLS: Record<ProjectExecutor, readonly ModelProviderProtocol[]> = {
  claude: ['anthropic/messages'],
  codex: ['openai/responses', 'codex/responses'],
};
const PROJECT_EXECUTORS: readonly ProjectExecutor[] = ['claude', 'codex'];

function executorModelOptions(providers: ModelProviderView[], executor: ProjectExecutor) {
  const seen = new Set<string>();
  return providers
    .filter((provider) => EXECUTOR_PROTOCOLS[executor].includes(provider.protocol))
    .flatMap((provider) => (provider.models ?? []).map((model) => `${provider.name}/${model}`))
    .filter((model) => {
      if (seen.has(model)) return false;
      seen.add(model);
      return true;
    });
}

function executorModelFromSelectValue(value: string): string {
  if (value === EXECUTOR_DEFAULT_VALUE) return '';
  if (value.startsWith(EXECUTOR_MODEL_VALUE_PREFIX)) return value.slice(EXECUTOR_MODEL_VALUE_PREFIX.length);
  if (value.startsWith(EXECUTOR_CURRENT_VALUE_PREFIX)) return value.slice(EXECUTOR_CURRENT_VALUE_PREFIX.length);
  return value;
}

type ExecutorsConfigurationProps = {
  providers: ModelProviderView[];
  defaultExecutor: ProjectExecutor;
  onDefaultExecutorChange: (executor: ProjectExecutor) => void;
  executorModels: Record<ProjectExecutor, string>;
  onExecutorModelChange: (executor: ProjectExecutor, value: string) => void;
  executorContext: string;
  onExecutorContextChange: (text: string) => void;
  onExecutorContextSave: () => void;
  projectTaskMcpServerIds: string[];
  onProjectTaskMcpServerIdsChange: (ids: string[]) => void;
  saving: boolean;
  loading: boolean;
  error: string;
  loadFailed: boolean;
  providersLoading: boolean;
  providersLoadFailed: boolean;
  onReload: () => void;
};

export function ExecutorsConfiguration({ providers, defaultExecutor, onDefaultExecutorChange, executorModels, onExecutorModelChange, executorContext, onExecutorContextChange, onExecutorContextSave, projectTaskMcpServerIds, onProjectTaskMcpServerIdsChange, saving, loading, error, loadFailed, providersLoading, providersLoadFailed, onReload }: ExecutorsConfigurationProps) {
  const { t } = useTranslation('assistant');
  const mcpServersQuery = useMcpServersQuery('personal');
  const mcpServers = mcpServersQuery.data ?? [];
  if (loading) return <div className="mx-auto w-full max-w-[840px] space-y-5 px-4 py-6 md:px-6 md:py-8" role="status" aria-label={t('composer.loading')}><Skeleton className="h-10 w-full" /><Skeleton className="h-32 w-full" /><Skeleton className="h-20 w-full" /></div>;
  if (loadFailed) return <div className="mx-auto w-full max-w-[840px] space-y-3 px-4 py-6 md:px-6 md:py-8"><p role="alert" className="text-sm text-danger">{t('configuration.loadFailed')}</p><Button variant="secondary" onClick={onReload}>{t('history.retry')}</Button></div>;
  return <form className="mx-auto w-full max-w-[840px] space-y-6 px-4 py-6 md:px-6 md:py-8" onSubmit={(event) => event.preventDefault()}>
    {providersLoadFailed ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5"><p className="text-[13px] text-danger">{t('configuration.executorModelLoadFailed')}</p><Button type="button" variant="secondary" size="compact" onClick={onReload}>{t('history.retry')}</Button></div> : null}
    <section className="min-w-0 space-y-5 rounded-lg border border-border bg-surface-subtle/40 p-4" aria-labelledby="chat-executor-configuration-heading">
      <h3 id="chat-executor-configuration-heading" className="text-sm font-semibold">{t('configuration.executorConfiguration')}</h3>
      <label className="block space-y-2" htmlFor="chat-executor-context"><span className="text-sm font-medium">{t('configuration.executorContext')}</span><Textarea id="chat-executor-context" rows={8} value={executorContext} onChange={(event) => onExecutorContextChange(event.target.value)} onBlur={onExecutorContextSave} disabled={saving} /><span className="block text-xs text-muted-foreground">{t('configuration.executorContextHint')}</span></label>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="chat-default-executor">{t('configuration.defaultExecutor')}</label>
        <Select value={defaultExecutor} onValueChange={(value) => onDefaultExecutorChange(value as ProjectExecutor)} disabled={saving}>
          <SelectTrigger id="chat-default-executor"><SelectValue /></SelectTrigger>
          <SelectContent>{PROJECT_EXECUTORS.map((executor) => <SelectItem key={executor} value={executor}>{t(`configuration.executorName.${executor}`)}</SelectItem>)}</SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t('configuration.defaultExecutorHint')}</p>
      </div>
      <div className="space-y-4 border-t border-border pt-5" role="group" aria-labelledby="chat-executor-models-heading">
        <div className="space-y-1"><h4 id="chat-executor-models-heading" className="text-sm font-medium">{t('configuration.executorModels')}</h4><p className="text-xs text-muted-foreground">{t('configuration.executorModelsHint')}</p></div>
        {/* Choosing a model writes one id. Older configurations may still contain an ordered fallback list; it is shown as the current value and stays untouched until the reader replaces it. */}
        {PROJECT_EXECUTORS.map((executor) => {
          const options = executorModelOptions(providers, executor);
          const optionSet = new Set(options);
          const currentValue = executorModels[executor];
          const currentInOptions = optionSet.has(currentValue);
          const selectedValue = currentValue ? `${currentInOptions ? EXECUTOR_MODEL_VALUE_PREFIX : EXECUTOR_CURRENT_VALUE_PREFIX}${currentValue}` : EXECUTOR_DEFAULT_VALUE;
          return <div key={executor} className="space-y-2"><label className="text-[13px] font-medium" htmlFor={`chat-executor-model-${executor}`}>{t(`configuration.executorModel.${executor}`)}</label><Select value={selectedValue} onValueChange={(value) => onExecutorModelChange(executor, executorModelFromSelectValue(value))} disabled={saving || providersLoading || providersLoadFailed}><SelectTrigger id={`chat-executor-model-${executor}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value={EXECUTOR_DEFAULT_VALUE}>{t('configuration.executorDefault')}</SelectItem>{currentValue && !currentInOptions ? <SelectItem value={`${EXECUTOR_CURRENT_VALUE_PREFIX}${currentValue}`}>{t('configuration.executorModelUnavailable', { model: currentValue })}</SelectItem> : null}{options.map((option) => <SelectItem key={option} value={`${EXECUTOR_MODEL_VALUE_PREFIX}${option}`}>{option}</SelectItem>)}</SelectContent></Select>{providersLoading ? <p role="status" className="text-xs text-muted-foreground">{t('configuration.executorModelLoading')}</p> : providersLoadFailed ? null : options.length === 0 ? <p className="text-xs text-muted-foreground">{t('configuration.executorModelEmpty')}</p> : null}{currentValue && !currentInOptions ? <p className="text-xs text-muted-foreground">{t('configuration.executorModelUnavailableHint')}</p> : null}</div>;
        })}
      </div>
      <div className="space-y-3 border-t border-border pt-5" role="group" aria-labelledby="chat-project-task-mcp-servers-heading">
        <div className="space-y-1"><h4 id="chat-project-task-mcp-servers-heading" className="text-sm font-medium">{t('configuration.projectTaskMcpServers')}</h4><p className="text-xs text-muted-foreground">{t('configuration.projectTaskMcpServersHint')}</p></div>
        {mcpServersQuery.isLoading ? <Skeleton className="h-12 w-full" /> : mcpServersQuery.isError ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5"><p className="text-[13px] text-danger">{t('configuration.projectTaskMcpServersLoadFailed')}</p><Button type="button" variant="secondary" size="compact" onClick={() => { void onReload(); void mcpServersQuery.refetch(); }}>{t('history.retry')}</Button></div> : mcpServers.length || projectTaskMcpServerIds.length ? <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border border-border p-2">{mcpServers.map((server) => { const checked = projectTaskMcpServerIds.includes(server.id); return <label key={server.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px]"><Checkbox checked={checked} disabled={saving} onCheckedChange={(value) => { const nextIds = value === true ? [...new Set([...projectTaskMcpServerIds, server.id])] : projectTaskMcpServerIds.filter((id) => id !== server.id); onProjectTaskMcpServerIdsChange(nextIds); }} aria-label={server.name} /><span className="min-w-0 flex-1 truncate">{server.name}</span></label>; })}{projectTaskMcpServerIds.filter((id) => !mcpServers.some((server) => server.id === id)).map((id) => <label key={id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px]"><Checkbox checked disabled={saving} onCheckedChange={() => onProjectTaskMcpServerIdsChange(projectTaskMcpServerIds.filter((serverId) => serverId !== id))} aria-label={id} /><span className="min-w-0 flex-1 truncate">{id}</span></label>)}</div> : <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[13px] text-muted-foreground">{t('configuration.projectTaskMcpServersEmpty')}</p>}
      </div>
    </section>
    {saving ? <p className="text-[13px] text-muted-foreground" role="status">{t('configuration.saving')}</p> : null}
    {error ? <p className="text-[13px] text-danger" role="alert">{error}</p> : null}
  </form>;
}
