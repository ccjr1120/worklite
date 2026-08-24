import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AuthShell } from '@/components/auth-shell';
import { RedirectIfAuthed } from '@/components/require-session';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/password-input';
import { useSessionStore } from '@/stores/session-store';

export const Route = createFileRoute('/sign-up')({
  component: SignUpPage,
});

function SignUpPage() {
  return (
    <RedirectIfAuthed>
      <SignUpForm />
    </RedirectIfAuthed>
  );
}

function SignUpForm() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const signUp = useSessionStore((state) => state.signUp);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; email?: string; password?: string }>({});

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: { name?: string; email?: string; password?: string } = {};
    if (!name.trim()) nextErrors.name = t('validation.nameRequired');
    if (!email.trim()) nextErrors.email = t('validation.emailRequired');
    if (password.length < 10) nextErrors.password = t('validation.passwordLength');
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    setSubmitting(true);
    window.setTimeout(() => {
      signUp(name.trim(), email.trim());
      void navigate({ to: '/verify-email' });
    }, 400);
  }

  return (
    <AuthShell
      title={t('signUp.title')}
      description={t('signUp.description')}
      onSubmit={onSubmit}
      footer={
        <div className="space-y-3">
          <p>
            <Trans
              ns="auth"
              i18nKey="signUp.haveAccount"
              components={{
                link: <Link to="/sign-in" className="font-medium text-foreground hover:text-brand" />,
              }}
            />
          </p>
          <p className="text-xs">{t('signUp.terms')}</p>
        </div>
      }
    >
      <Field label={t('signUp.fullName')} htmlFor="name" error={fieldErrors.name}>
        <Input id="name" name="name" autoComplete="name" autoFocus value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label={t('fields.email')} htmlFor="email" error={fieldErrors.email}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={t('fields.emailPlaceholder')}
        />
      </Field>
      <Field label={t('fields.password')} htmlFor="password" hint={t('fields.passwordHint')} error={fieldErrors.password}>
        <PasswordInput
          id="password"
          name="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? t('signUp.submitting') : t('signUp.submit')}
      </Button>
    </AuthShell>
  );
}
