import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useSessionStore } from '@/stores/session-store';

export const Route = createFileRoute('/onboarding/team')({
  component: OnboardingTeamPage,
});

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
}

function OnboardingTeamPage() {
  const { t } = useTranslation(['onboarding', 'common']);
  const navigate = useNavigate();
  const completeOnboardingStep = useSessionStore((state) => state.completeOnboardingStep);
  const setTeam = useSessionStore((state) => state.setTeam);
  const [name, setName] = useState('Acme');
  const [slug, setSlug] = useState('acme');
  const [slugTouched, setSlugTouched] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTeam(slug || 'acme');
    completeOnboardingStep('provider');
    void navigate({ to: '/onboarding/provider' });
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('team.title')}</h1>
        <p className="mt-2 text-[13px] text-muted-foreground">{t('team.description')}</p>
      </div>
      <Field label={t('team.name')} htmlFor="name">
        <Input
          id="name"
          value={name}
          autoFocus
          onChange={(event) => {
            setName(event.target.value);
            if (!slugTouched) setSlug(slugify(event.target.value));
          }}
        />
      </Field>
      <Field label={t('team.url')} htmlFor="slug" hint={t('team.urlHint')}>
        <Input
          id="slug"
          value={slug}
          onChange={(event) => {
            setSlugTouched(true);
            setSlug(slugify(event.target.value));
          }}
        />
      </Field>
      <Button type="submit" disabled={!name.trim() || !slug}>
        {t('common:actions.continue')}
      </Button>
    </form>
  );
}
