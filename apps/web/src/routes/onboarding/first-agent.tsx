import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useSessionStore } from '@/stores/session-store';
import { useLocale } from '@/components/locale-provider';

export const Route = createFileRoute('/onboarding/first-agent')({
  component: OnboardingFirstAgentPage,
});

function OnboardingFirstAgentPage() {
  const { t } = useTranslation('onboarding');
  const { locale } = useLocale();
  const navigate = useNavigate();
  const completeOnboardingStep = useSessionStore((state) => state.completeOnboardingStep);
  const templates = useMemo(
    () => [
      { id: 'researcher', name: t('firstAgent.templates.researcher.name'), responsibility: t('firstAgent.templates.researcher.responsibility') },
      { id: 'writer', name: t('firstAgent.templates.writer.name'), responsibility: t('firstAgent.templates.writer.responsibility') },
    ],
    [t],
  );
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? 'researcher');
  const template = templates.find((item) => item.id === templateId) ?? templates[0];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('firstAgent.title')}</h1>
        <p className="mt-2 text-[13px] text-muted-foreground">{t('firstAgent.description')}</p>
      </div>
      <div className="flex gap-2">
        {templates.map((item) => (
          <Button key={item.id} type="button" variant={templateId === item.id ? 'primary' : 'secondary'} size="compact" onClick={() => setTemplateId(item.id)}>
            {item.name}
          </Button>
        ))}
      </div>
      <Field label={t('firstAgent.name')} htmlFor="name">
        <Input id="name" defaultValue={template?.name} key={`${locale}-${templateId}`} />
      </Field>
      <Field label={t('firstAgent.responsibility')} htmlFor="responsibility">
        <Textarea id="responsibility" defaultValue={template?.responsibility} key={`${locale}-${templateId}-resp`} />
      </Field>
      <Button
        onClick={() => {
          completeOnboardingStep('complete');
          void navigate({ to: '/agents/$agentId', params: { agentId: 'agt_researcher' } });
        }}
      >
        {t('firstAgent.submit')}
      </Button>
    </div>
  );
}
