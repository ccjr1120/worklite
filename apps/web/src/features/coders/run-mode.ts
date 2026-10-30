import type { TFunction } from 'i18next';
import type { AgentTeamRunView } from '@worklite/contracts';

// v10 Runs hold a placeholder mode until the executor Dispatcher decides; v1-v9
// Runs show the mode captured at dispatch.
export function runModeLabel(t: TFunction<'coders'>, mode: AgentTeamRunView['mode'], orchestrationVersion: number, modeDecidedAt: string | null): string {
  if (orchestrationVersion < 10) return t(`run.modeValue.${mode}`);
  if (!modeDecidedAt) return t('run.modePending');
  return t('run.modeDecided', { mode: t(`run.modeValue.${mode}`) });
}
