import { useTranslation } from 'react-i18next';
import type { McpServerView, ModelProviderView, SkillView } from '@worklite/contracts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';

type ConfigurationProps = {
  providers: ModelProviderView[];
  mcpServers: McpServerView[];
  skills: SkillView[];
  selection: string;
  onSelectionChange: (value: string) => void;
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

export function Configuration({ providers, mcpServers, skills, selection, onSelectionChange, selectedMcpServerIds, onMcpServersChange, selectedSkillIds, onSkillsChange, extensionPrompt, onPromptChange, onPromptSave, saving, loading, error, loadFailed, onReload }: ConfigurationProps) {
  const { t } = useTranslation('assistant');
  if (loading) return <div className="mx-auto max-w-3xl space-y-5 p-6" role="status" aria-label={t('composer.loading')}><Skeleton className="h-10 w-full" /><Skeleton className="h-32 w-full" /><Skeleton className="h-20 w-full" /></div>;
  if (loadFailed) return <div className="mx-auto max-w-3xl space-y-3 p-6"><p role="alert" className="text-sm text-danger">{t('configuration.loadFailed')}</p><Button variant="secondary" onClick={onReload}>{t('history.retry')}</Button></div>;
  return <form className="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-6" onSubmit={(event) => event.preventDefault()}>
    <label className="block space-y-2" htmlFor="chat-model-selection"><span className="text-sm font-medium">{t('configuration.model')}</span><Select value={selection} onValueChange={onSelectionChange} disabled={saving}><SelectTrigger id="chat-model-selection"><SelectValue placeholder={t('configuration.placeholder')} /></SelectTrigger><SelectContent>{providers.flatMap((provider) => (provider.models ?? []).map((model) => <SelectItem key={`${provider.id}::${model}`} value={`${provider.id}::${model}`}>{provider.name} / {model}</SelectItem>))}</SelectContent></Select></label>
    <label className="block space-y-2" htmlFor="chat-extension-prompt"><span className="text-sm font-medium">{t('configuration.prompt')}</span><Textarea id="chat-extension-prompt" rows={6} value={extensionPrompt} onChange={(event) => onPromptChange(event.target.value)} onBlur={onPromptSave} disabled={saving} /><span className="block text-xs text-muted-foreground">{t('configuration.nextTurn')}</span></label>
    <fieldset className="space-y-3" disabled={saving}><legend className="mb-2 text-sm font-medium">{t('configuration.skills')}</legend>{skills.map((skill) => <label key={skill.id} className="flex items-center gap-2 text-sm"><Checkbox checked={selectedSkillIds.includes(skill.id)} disabled={saving || skill.id === 'sk_worklite_platform'} onCheckedChange={(checked) => onSkillsChange(checked === true ? [...selectedSkillIds, skill.id] : selectedSkillIds.filter((id) => id !== skill.id))} />{skill.name}{skill.id === 'sk_worklite_platform' ? <span className="text-xs text-muted-foreground">{t('configuration.builtIn')}</span> : null}</label>)}</fieldset>
    <fieldset className="space-y-3" disabled={saving}><legend className="mb-2 text-sm font-medium">{t('configuration.mcpServers')}</legend>{mcpServers.map((server) => <label key={server.id} className="flex items-center gap-2 text-sm"><Checkbox checked={selectedMcpServerIds.includes(server.id)} disabled={saving} onCheckedChange={(checked) => onMcpServersChange(checked === true ? [...selectedMcpServerIds, server.id] : selectedMcpServerIds.filter((id) => id !== server.id))} />{server.name}</label>)}</fieldset>
    {saving ? <p className="text-[13px] text-muted-foreground" role="status">{t('configuration.saving')}</p> : null}
    {error ? <p className="text-[13px] text-danger" role="alert">{error}</p> : null}
  </form>;
}
