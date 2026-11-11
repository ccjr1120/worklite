import { ModelParametersFields } from '@/components/model-parameters-fields';
import type { ModelParameters } from '@worklite/contracts';
import { useTranslation } from 'react-i18next';
import type { ModelProviderView, SkillView } from '@worklite/contracts';
import { CHAT_TURN_NOTIFICATION_SOUNDS } from '@worklite/contracts';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';

type ConfigurationProps = {
  providers: ModelProviderView[];
  skills: SkillView[];
  selectedSkillIds: string[];
  onSkillIdsChange: (ids: string[]) => void;
  skillsLoading: boolean;
  skillsLoadFailed: boolean;
  modelParameters?: ModelParameters;
  onModelParametersChange?: (value: ModelParameters) => void;
  selection: string;
  onSelectionChange: (value: string) => void;
  extensionPrompt: string;
  onPromptChange: (text: string) => void;
  onPromptSave: () => void;
  summarizePrompt: string;
  onSummarizePromptChange: (text: string) => void;
  onSummarizePromptSave: () => void;
  turnNotificationsEnabled: boolean;
  turnNotificationSound: string;
  onTurnNotificationsChange: (enabled: boolean, sound: string) => void;
  saving: boolean;
  loading: boolean;
  error: string;
  loadFailed: boolean;
  providersLoading: boolean;
  providersLoadFailed: boolean;
  onReload: () => void;
};

// An empty stored sound name means a silent notification; Select needs a non-empty option value for it.
const SILENT_SOUND = 'silent';

export function Configuration({ modelParameters = {}, onModelParametersChange, providers, skills, selectedSkillIds, onSkillIdsChange, skillsLoading, skillsLoadFailed, selection, onSelectionChange, extensionPrompt, onPromptChange, onPromptSave, summarizePrompt, onSummarizePromptChange, onSummarizePromptSave, turnNotificationsEnabled, turnNotificationSound, onTurnNotificationsChange, saving, loading, error, loadFailed, providersLoading, providersLoadFailed, onReload }: ConfigurationProps) {
  const { t } = useTranslation('assistant');
  if (loading) return <div className="mx-auto w-full max-w-[840px] space-y-5 px-4 py-6 md:px-6 md:py-8" role="status" aria-label={t('composer.loading')}><Skeleton className="h-10 w-full" /><Skeleton className="h-32 w-full" /><Skeleton className="h-20 w-full" /></div>;
  if (loadFailed) return <div className="mx-auto w-full max-w-[840px] space-y-3 px-4 py-6 md:px-6 md:py-8"><p role="alert" className="text-sm text-danger">{t('configuration.loadFailed')}</p><Button variant="secondary" onClick={onReload}>{t('history.retry')}</Button></div>;
  return <form className="mx-auto w-full max-w-[840px] space-y-6 px-4 py-6 md:px-6 md:py-8" onSubmit={(event) => event.preventDefault()}>
    {providersLoadFailed ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5"><p className="text-[13px] text-danger">{t('configuration.modelDirectoryLoadFailed')}</p><Button type="button" variant="secondary" size="compact" onClick={onReload}>{t('history.retry')}</Button></div> : null}
    {providersLoading ? <div className="block space-y-2" role="status"><span className="text-sm font-medium">{t('configuration.model')}</span><Skeleton className="h-[38px] w-full" /><span className="block text-xs text-muted-foreground">{t('configuration.modelDirectoryLoading')}</span></div> : <label className="block space-y-2" htmlFor="chat-model-selection"><span className="text-sm font-medium">{t('configuration.model')}</span><Select value={selection} onValueChange={onSelectionChange} disabled={saving || providersLoadFailed}><SelectTrigger id="chat-model-selection"><SelectValue placeholder={providersLoadFailed ? t('configuration.modelDirectoryUnavailable') : t('configuration.placeholder')} /></SelectTrigger><SelectContent>{providers.flatMap((provider) => (provider.models ?? []).map((model) => <SelectItem key={`${provider.id}::${model}`} value={`${provider.id}::${model}`}>{provider.name} / {model}</SelectItem>))}</SelectContent></Select></label>}
    {selection && onModelParametersChange ? <ModelParametersFields key={selection} value={modelParameters} onChange={onModelParametersChange} runtime="native" protocol={providers.find((provider) => selection.startsWith(`${provider.id}::`))?.protocol} disabled={saving || providersLoading || providersLoadFailed} /> : null}
    <fieldset className="min-w-0 space-y-2"><legend className="text-sm font-medium">{t('configuration.skills')}</legend><p className="text-xs text-muted-foreground">{t('configuration.skillsHint')}</p>{skillsLoading ? <Skeleton className="h-12 w-full" /> : skillsLoadFailed ? <p role="alert" className="text-[13px] text-danger">{t('configuration.skillsLoadFailed')}</p> : skills.length ? <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-border p-2">{skills.map((skill) => { const checked = selectedSkillIds.includes(skill.id); return <label key={skill.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px]"><Checkbox checked={checked} disabled={saving} onCheckedChange={(value) => { const nextIds = value === true ? [...new Set([...selectedSkillIds, skill.id])] : selectedSkillIds.filter((id) => id !== skill.id); onSkillIdsChange(nextIds); }} aria-label={skill.name} /><span>{skill.name}</span></label>; })}</div> : <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[13px] text-muted-foreground">{t('configuration.skillsEmpty')}</p>}</fieldset>
    <label className="block space-y-2" htmlFor="chat-extension-prompt"><span className="text-sm font-medium">{t('configuration.prompt')}</span><Textarea id="chat-extension-prompt" rows={6} value={extensionPrompt} onChange={(event) => onPromptChange(event.target.value)} onBlur={onPromptSave} disabled={saving} /><span className="block text-xs text-muted-foreground">{t('configuration.promptHint')}</span></label>
    <label className="block space-y-2" htmlFor="chat-summarize-prompt"><span className="text-sm font-medium">{t('configuration.summarizePrompt')}</span><Textarea id="chat-summarize-prompt" rows={6} value={summarizePrompt} onChange={(event) => onSummarizePromptChange(event.target.value)} onBlur={onSummarizePromptSave} disabled={saving} /><span className="block text-xs text-muted-foreground">{t('configuration.summarizePromptHint')}</span></label>
    <fieldset className="min-w-0 space-y-2"><legend className="text-sm font-medium">{t('configuration.turnNotifications')}</legend><p className="text-xs text-muted-foreground">{t('configuration.turnNotificationsHint')}</p><label className="flex items-center gap-2 text-[13px]"><Checkbox checked={turnNotificationsEnabled} disabled={saving} onCheckedChange={(value) => onTurnNotificationsChange(value === true, turnNotificationSound)} aria-label={t('configuration.turnNotificationsEnabled')} /><span>{t('configuration.turnNotificationsEnabled')}</span></label><label className="block space-y-2" htmlFor="chat-turn-notification-sound"><span className="text-[13px]">{t('configuration.turnNotificationSound')}</span><Select value={turnNotificationSound || SILENT_SOUND} onValueChange={(value) => onTurnNotificationsChange(turnNotificationsEnabled, value === SILENT_SOUND ? '' : value)} disabled={saving || !turnNotificationsEnabled}><SelectTrigger id="chat-turn-notification-sound"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={SILENT_SOUND}>{t('configuration.turnNotificationSoundSilent')}</SelectItem>{CHAT_TURN_NOTIFICATION_SOUNDS.map((sound) => <SelectItem key={sound} value={sound}>{sound}</SelectItem>)}</SelectContent></Select></label></fieldset>
    {saving ? <p className="text-[13px] text-muted-foreground" role="status">{t('configuration.saving')}</p> : null}
    {error ? <p className="text-[13px] text-danger" role="alert">{error}</p> : null}
  </form>;
}
