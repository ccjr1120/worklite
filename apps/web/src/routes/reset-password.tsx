import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthShell } from '@/components/auth-shell';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { PasswordInput } from '@/components/password-input';

export const Route = createFileRoute('/reset-password')({
  component: ResetPasswordPage,
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : '',
  }),
});

function ResetPasswordPage() {
  const { t } = useTranslation('auth');
  const { token } = Route.useSearch();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const invalidToken = token === 'expired';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 10) {
      setError(t('validation.passwordLength'));
      return;
    }
    if (password !== confirm) {
      setError(t('validation.passwordMismatch'));
      return;
    }
    setError('');
    setSubmitting(true);
    window.setTimeout(() => {
      setSubmitting(false);
      setSuccess(true);
    }, 400);
  }

  if (invalidToken) {
    return (
      <AuthShell title={t('resetPassword.unavailableTitle')} description={t('resetPassword.unavailableDescription')}>
        <Button asChild className="w-full">
          <Link to="/forgot-password">{t('resetPassword.requestNew')}</Link>
        </Button>
      </AuthShell>
    );
  }

  if (success) {
    return (
      <AuthShell title={t('resetPassword.updatedTitle')} description={t('resetPassword.updatedDescription')}>
        <Button type="button" className="w-full" onClick={() => void navigate({ to: '/sign-in' })}>
          {t('resetPassword.continue')}
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t('resetPassword.title')} description={t('resetPassword.description')} onSubmit={onSubmit}>
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      <Field label={t('resetPassword.newPassword')} htmlFor="password" hint={t('fields.passwordHint')}>
        <PasswordInput
          id="password"
          name="password"
          autoComplete="new-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <Field label={t('resetPassword.confirmPassword')} htmlFor="confirm">
        <PasswordInput
          id="confirm"
          name="confirm"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </Field>
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? t('resetPassword.submitting') : t('resetPassword.submit')}
      </Button>
    </AuthShell>
  );
}
