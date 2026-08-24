import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/password-input';
import { useSessionStore } from '@/stores/session-store';

export const Route = createFileRoute('/onboarding/provider')({
  component: OnboardingProviderPage,
});

function OnboardingProviderPage() {
  const { t } = useTranslation(['onboarding', 'common']);
  const navigate = useNavigate();
  const completeOnboardingStep = useSessionStore((state) => state.completeOnboardingStep);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('provider.title')}</h1>
        <p className="mt-2 text-[13px] text-muted-foreground">{t('provider.description')}</p>
      </div>
      <Field label={t('provider.provider')} htmlFor="provider">
        <Input id="provider" value="Anthropic" readOnly />
      </Field>
      <Field label={t('provider.apiKey')} htmlFor="key">
        <PasswordInput id="key" name="api-key" autoComplete="off" placeholder="sk-ant-…" defaultValue="" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={testing}
          onClick={() => {
            setTesting(true);
            window.setTimeout(() => {
              setTesting(false);
              setTested(true);
            }, 500);
          }}
        >
          {testing ? t('provider.testing') : tested ? t('provider.succeeded') : t('provider.test')}
        </Button>
        <Button
          type="button"
          onClick={() => {
            completeOnboardingStep('first-agent');
            void navigate({ to: '/onboarding/first-agent' });
          }}
        >
          {t('common:actions.continue')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            completeOnboardingStep('first-agent');
            void navigate({ to: '/onboarding/first-agent' });
          }}
        >
          {t('common:actions.skip')}
        </Button>
      </div>
    </div>
  );
}
