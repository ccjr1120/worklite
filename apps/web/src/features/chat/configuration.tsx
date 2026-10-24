import { useTranslation } from 'react-i18next';
import type { ModelProviderView, ProjectExecutor } from '@worklite/contracts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

type ConfigurationProps = {
  providers: ModelProviderView[];
  selection: string;
  onSelectionChange: (value: string) => void;
  executorModels: Record<ProjectExecutor, string>;
  onExecutorModelChange: (executor: ProjectExecutor, value: string) => void;
  onExecutorModelSave: (executor: ProjectExecutor) => void;
  extensionPrompt: string;
  onPromptChange: (text: string) => void;
  onPromptSave: () => void;
  summarizePrompt: string;
  onSummarizePromptChange: (text: string) => void;
  onSummarizePromptSave: () => void;
  saving: boolean;
  loading: boolean;
  error: string;
  loadFailed: boolean;
  onReload: () => void;
};

export function Configuration({ providers, selection, onSelectionChange, executorModels, onExecutorModelChange, onExecutorModelSave, extensionPrompt, onPromptChange, onPromptSave, summarizePrompt, onSummarizePromptChange, onSummarizePromptSave, saving, loading, error, loadFailed, onReload }: ConfigurationProps) {
  const { t } = useTranslation('assistant');
  if (loading) return <div className="mx-auto w-full max-w-[840px] space-y-5 px-4 py-6 md:px-6 md:py-8" role="status" aria-label={t('composer.loading')}><Skeleton className="h-10 w-full" /><Skeleton className="h-32 w-full" /><Skeleton className="h-20 w-full" /></div>;
  if (loadFailed) return <div className="mx-auto w-full max-w-[840px] space-y-3 px-4 py-6 md:px-6 md:py-8"><p role="alert" className="text-sm text-danger">{t('configuration.loadFailed')}</p><Button variant="secondary" onClick={onReload}>{t('history.retry')}</Button></div>;
  return <form className="mx-auto w-full max-w-[840px] space-y-6 px-4 py-6 md:px-6 md:py-8" onSubmit={(event) => event.preventDefault()}>
    <label className="block space-y-2" htmlFor="chat-model-selection"><span className="text-sm font-medium">{t('configuration.model')}</span><Select value={selection} onValueChange={onSelectionChange} disabled={saving}><SelectTrigger id="chat-model-selection"><SelectValue placeholder={t('configuration.placeholder')} /></SelectTrigger><SelectContent>{providers.flatMap((provider) => (provider.models ?? []).map((model) => <SelectItem key={`${provider.id}::${model}`} value={`${provider.id}::${model}`}>{provider.name} / {model}</SelectItem>))}</SelectContent></Select></label>
    {/* A declared default is one public model id, or an ordered comma-separated list of fallback candidates (first entry tried first); empty keeps the executor's own local default. */}
    <fieldset className="min-w-0 space-y-4"><legend className="mb-3 text-sm font-medium">{t('configuration.executors')}</legend>{(['claude', 'codex'] as const).map((executor) => <label key={executor} className="block space-y-2" htmlFor={`chat-executor-model-${executor}`}><span className="text-[13px] text-muted-foreground">{t(`configuration.executorModel.${executor}`)}</span><Input id={`chat-executor-model-${executor}`} value={executorModels[executor]} placeholder={t('configuration.executorDefault')} onChange={(event) => onExecutorModelChange(executor, event.target.value)} onBlur={() => onExecutorModelSave(executor)} disabled={saving} /></label>)}</fieldset>
    <label className="block space-y-2" htmlFor="chat-extension-prompt"><span className="text-sm font-medium">{t('configuration.prompt')}</span><Textarea id="chat-extension-prompt" rows={6} value={extensionPrompt} onChange={(event) => onPromptChange(event.target.value)} onBlur={onPromptSave} disabled={saving} /><span className="block text-xs text-muted-foreground">{t('configuration.nextTurn')}</span></label>
    <label className="block space-y-2" htmlFor="chat-summarize-prompt"><span className="text-sm font-medium">{t('configuration.summarizePrompt')}</span><Textarea id="chat-summarize-prompt" rows={6} value={summarizePrompt} onChange={(event) => onSummarizePromptChange(event.target.value)} onBlur={onSummarizePromptSave} disabled={saving} /><span className="block text-xs text-muted-foreground">{t('configuration.summarizePromptHint')}</span></label>
    {saving ? <p className="text-[13px] text-muted-foreground" role="status">{t('configuration.saving')}</p> : null}
    {error ? <p className="text-[13px] text-danger" role="alert">{error}</p> : null}
  </form>;
}
