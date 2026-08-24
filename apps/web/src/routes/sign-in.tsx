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

type SignInSearch = {
  expired?: boolean;
};

export const Route = createFileRoute('/sign-in')({
  component: SignInPage,
  validateSearch: (search: Record<string, unknown>): SignInSearch => {
    if (search.expired === true || search.expired === '1' || search.expired === 'true') {
      return { expired: true };
    }
    return {};
  },
});

function SignInPage() {
  return (
    <RedirectIfAuthed>
      <SignInForm />
    </RedirectIfAuthed>
  );
}

function SignInForm() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const { expired: expiredFromSearch } = Route.useSearch();
  const signIn = useSessionStore((state) => state.signIn);
  const sessionExpired = useSessionStore((state) => state.sessionExpired);
  const session = useSessionStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const showExpiredNotice = expiredFromSearch || sessionExpired;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: { email?: string; password?: string } = {};
    if (!email.trim()) nextErrors.email = t('validation.emailRequired');
    if (!password) nextErrors.password = t('validation.passwordRequired');
    setFieldErrors(nextErrors);
    if (nextErrors.email || nextErrors.password) return;

    setSubmitting(true);
    setFormError('');
    window.setTimeout(() => {
      signIn(email.trim());
      void navigate({ to: '/$teamSlug/home', params: { teamSlug: session.currentTeamSlug || 'acme' } });
    }, 400);
  }

  return (
    <AuthShell
      title={t('signIn.title')}
      description={t('signIn.description')}
      onSubmit={onSubmit}
      footer={
        <p>
          <Trans
            ns="auth"
            i18nKey="signIn.needAccount"
            components={{
              link: <Link to="/sign-up" className="font-medium text-foreground hover:text-brand" />,
            }}
          />
        </p>
      }
    >
      {showExpiredNotice ? (
        <p role="status" className="rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-foreground">
          {t('signIn.expired')}
        </p>
      ) : null}
      {formError ? (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[13px] text-danger">
          {formError}
        </p>
      ) : null}
      <Field label={t('fields.email')} htmlFor="email" error={fieldErrors.email}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={t('fields.emailPlaceholder')}
        />
      </Field>
      <Field label={t('fields.password')} htmlFor="password" error={fieldErrors.password}>
        <PasswordInput
          id="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <div className="flex justify-end">
        <Link to="/forgot-password" className="text-[13px] text-muted-foreground hover:text-foreground">
          {t('signIn.forgotPassword')}
        </Link>
      </div>
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? t('signIn.submitting') : t('signIn.submit')}
      </Button>
    </AuthShell>
  );
}
