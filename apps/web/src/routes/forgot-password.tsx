import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthShell } from '@/components/auth-shell';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

export const Route = createFileRoute('/forgot-password')({
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const { t } = useTranslation('auth');
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    window.setTimeout(() => {
      setSubmitting(false);
      setSubmitted(true);
    }, 400);
  }

  return (
    <AuthShell
      title={t('forgotPassword.title')}
      description={t('forgotPassword.description')}
      onSubmit={onSubmit}
      footer={
        <Link to="/sign-in" className="font-medium text-foreground hover:text-brand">
          {t('forgotPassword.returnToSignIn')}
        </Link>
      }
    >
      {submitted ? (
        <p className="rounded-md border border-border bg-surface px-3 py-2 text-[13px]">
          {t('forgotPassword.submitted')}
        </p>
      ) : (
        <>
          <Field label={t('fields.email')} htmlFor="email">
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Button type="submit" className="w-full" disabled={submitting || !email.trim()}>
            {submitting ? t('forgotPassword.submitting') : t('forgotPassword.submit')}
          </Button>
        </>
      )}
    </AuthShell>
  );
}
