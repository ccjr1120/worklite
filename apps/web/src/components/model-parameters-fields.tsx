import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MODEL_REASONING_EFFORTS, MODEL_SERVICE_TIERS, validateModelParameters, type ModelParameters } from '@worklite/contracts';
import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

type Props = {
  value: ModelParameters;
  onChange: (value: ModelParameters) => void;
  protocol?: string;
  runtime?: 'native' | 'codex' | 'claude';
  disabled?: boolean;
  onValidityChange?: (valid: boolean) => void;
};
const INHERIT = 'inherit';

export function ModelParametersFields({ value, onChange, protocol, runtime = 'native', disabled, onValidityChange }: Props) {
  const { t } = useTranslation('common');
  const id = useId();
  const serialized = JSON.stringify(value.requestBody ?? {}, null, 2);
  const [json, setJson] = useState(serialized);
  const [error, setError] = useState('');
  useEffect(() => { setJson(serialized); setError(''); onValidityChange?.(true); }, [serialized, onValidityChange]);
  const anthropic = runtime === 'claude' || protocol === 'anthropic/messages';
  const structured = runtime !== 'native' || anthropic || protocol?.startsWith('openai/') || protocol === 'codex/responses';
  const efforts = anthropic ? MODEL_REASONING_EFFORTS.filter((item) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(item)) : MODEL_REASONING_EFFORTS;
  const tiers = anthropic ? ['default', 'fast'] as const : runtime === 'codex' ? ['default', 'fast', 'flex'] as const : MODEL_SERVICE_TIERS;
  return <div className="space-y-3">
    {structured ? <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('modelParameters.reasoningEffort')} htmlFor={`${id}-effort`}>
        <Select value={value.reasoningEffort ?? INHERIT} disabled={disabled || Boolean(error)} onValueChange={(next) => onChange({ ...value, reasoningEffort: next === INHERIT ? undefined : next as ModelParameters['reasoningEffort'] })}>
          <SelectTrigger id={`${id}-effort`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value={INHERIT}>{t('modelParameters.inherit')}</SelectItem>{efforts.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <Field label={t('modelParameters.serviceTier')} htmlFor={`${id}-tier`}>
        <Select value={value.serviceTier ?? INHERIT} disabled={disabled || Boolean(error)} onValueChange={(next) => onChange({ ...value, serviceTier: next === INHERIT ? undefined : next as ModelParameters['serviceTier'] })}>
          <SelectTrigger id={`${id}-tier`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value={INHERIT}>{t('modelParameters.inherit')}</SelectItem>{tiers.map((tier) => <SelectItem key={tier} value={tier}>{tier === 'fast' ? t('modelParameters.fast') : tier}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
    </div> : null}
    {runtime === 'native' ? <Field label={t('modelParameters.requestBody')} htmlFor={`${id}-json`} error={error} hint={t('modelParameters.hint')}>
      <Textarea id={`${id}-json`} className="font-mono text-xs" rows={3} value={json} disabled={disabled} onChange={(event) => {
        const next = event.target.value;
        setJson(next);
        try { validateModelParameters({ ...value, requestBody: JSON.parse(next || '{}') }); event.target.setCustomValidity(''); setError(''); onValidityChange?.(true); }
        catch { const message = t('modelParameters.invalidJson'); event.target.setCustomValidity(message); setError(message); onValidityChange?.(false); }
      }} onBlur={() => {
        if (error) return;
        const requestBody = JSON.parse(json || '{}') as Record<string, unknown>;
        if (JSON.stringify(requestBody) !== JSON.stringify(value.requestBody ?? {})) onChange({ ...value, requestBody });
      }} />
    </Field> : null}
  </div>;
}
