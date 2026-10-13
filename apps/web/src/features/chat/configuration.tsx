import { useTranslation } from 'react-i18next';
import type { McpServerView, ModelProviderView, ProjectExecutor, SkillView } from '@worklite/contracts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';

// Radix Select items cannot use an empty value, so the follow-the-executor choice uses this placeholder.
const EXECUTOR_DEFAULT_VALUE = 'executor-default';
const EXECUTOR_PROTOCOLS: Record<ProjectExecutor, string[]> = {
  claude: ['anthropic/messages'],
  codex: ['openai/responses', 'codex/responses'],
};

type ConfigurationProps = {
  providers: ModelProviderView[];
  mcpServers: McpServerView[];
  skills: SkillView[];
  selection: string;
  onSelectionChange: (value: string) => void;
  executorModels: Record<ProjectExecutor, string>;
  onExecutorModelChange: (executor: ProjectExecutor, value: string) => void;
  selectedMcpServerIds: string[];
  onMcpServersChange: (ids: string[]) => void;
  selectedSkillIds: string[];
  onSkillsChange: (ids: string[]) => void;
  extensionPrompt: string;
  onPromptChange: (text: string) => void;
  onPromptSave: () => void;
  saving: boolean;
  loading: boolean;
  error: string;
  loadFailed: boolean;
  onReload: () => void;
};

export function Configuration({ providers, mcpServers, skills, selection, onSelectionChange, executorModels, onExecutorModelChange, selectedMcpServerIds, onMcpServersChange, selectedSkillIds, onSkillsChange, extensionPrompt, onPromptChange, onPromptSave, saving, loading, error, loadFailed, onReload }: ConfigurationProps) {
  const { t } = useTranslation('assistant');
  if (loading) return <div className="mx-auto w-full max-w-[840px] space-y-5 px-4 py-6 md:px-6 md:py-8" role="status" aria-label={t('composer.loading')}><Skeleton className="h-10 w-full" /><Skeleton className="h-32 w-full" /><Skeleton className="h-20 w-full" /></div>;
  if (loadFailed) return <div className="mx-auto w-full max-w-[840px] space-y-3 px-4 py-6 md:px-6 md:py-8"><p role="alert" className="text-sm text-danger">{t('configuration.loadFailed')}</p><Button variant="secondary" onClick={onReload}>{t('history.retry')}</Button></div>;
  const executorOptions = (executor: ProjectExecutor) => providers
    .filter((provider) => EXECUTOR_PROTOCOLS[executor].includes(provider.protocol))
    .flatMap((provider) => (provider.models ?? []).map((model) => ({ value: `${provider.name}/${model}`, label: `${provider.name} / ${model}` })));
  return <form className="mx-auto w-full max-w-[840px] space-y-6 px-4 py-6 md:px-6 md:py-8" onSubmit={(event) => event.preventDefault()}>
    <label className="block space-y-2" htmlFor="chat-model-selection"><span className="text-sm font-medium">{t('configuration.model')}</span><Select value={selection} onValueChange={onSelectionChange} disabled={saving}><SelectTrigger id="chat-model-selection"><SelectValue placeholder={t('configuration.placeholder')} /></SelectTrigger><SelectContent>{providers.flatMap((provider) => (provider.models ?? []).map((model) => <SelectItem key={`${provider.id}::${model}`} value={`${provider.id}::${model}`}>{provider.name} / {model}</SelectItem>))}</SelectContent></Select></label>
    {(['claude', 'codex'] as const).map((executor) => <label key={executor} className="block space-y-2" htmlFor={`chat-executor-model-${executor}`}><span className="text-sm font-medium">{t(`configuration.executorModel.${executor}`)}</span><Select value={executorModels[executor] || EXECUTOR_DEFAULT_VALUE} onValueChange={(value) => onExecutorModelChange(executor, value === EXECUTOR_DEFAULT_VALUE ? '' : value)} disabled={saving}><SelectTrigger id={`chat-executor-model-${executor}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value={EXECUTOR_DEFAULT_VALUE}>{t('configuration.executorDefault')}</SelectItem>{executorOptions(executor).map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></label>)}
    <label className="block space-y-2" htmlFor="chat-extension-prompt"><span className="text-sm font-medium">{t('configuration.prompt')}</span><Textarea id="chat-extension-prompt" rows={6} value={extensionPrompt} onChange={(event) => onPromptChange(event.target.value)} onBlur={onPromptSave} disabled={saving} /><span className="block text-xs text-muted-foreground">{t('configuration.nextTurn')}</span></label>
    <fieldset className="space-y-3" disabled={saving}><legend className="mb-2 text-sm font-medium">{t('configuration.skills')}</legend>{skills.map((skill) => <label key={skill.id} className="flex items-center gap-2 text-sm"><Checkbox checked={selectedSkillIds.includes(skill.id)} disabled={saving || skill.id === 'sk_worklite_platform'} onCheckedChange={(checked) => onSkillsChange(checked === true ? [...selectedSkillIds, skill.id] : selectedSkillIds.filter((id) => id !== skill.id))} />{skill.name}{skill.id === 'sk_worklite_platform' ? <span className="text-xs text-muted-foreground">{t('configuration.builtIn')}</span> : null}</label>)}</fieldset>
    <fieldset className="space-y-3" disabled={saving}><legend className="mb-2 text-sm font-medium">{t('configuration.mcpServers')}</legend>{mcpServers.map((server) => <label key={server.id} className="flex items-center gap-2 text-sm"><Checkbox checked={selectedMcpServerIds.includes(server.id)} disabled={saving} onCheckedChange={(checked) => onMcpServersChange(checked === true ? [...selectedMcpServerIds, server.id] : selectedMcpServerIds.filter((id) => id !== server.id))} />{server.name}</label>)}</fieldset>
    {saving ? <p className="text-[13px] text-muted-foreground" role="status">{t('configuration.saving')}</p> : null}
    {error ? <p className="text-[13px] text-danger" role="alert">{error}</p> : null}
  </form>;
}
