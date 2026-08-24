import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Mail } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthShell } from '@/components/auth-shell';
import { Button } from '@/components/ui/button';
import { useSessionStore } from '@/stores/session-store';

export const Route = createFileRoute('/verify-email')({
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const session = useSessionStore();
  const verifyEmail = useSessionStore((state) => state.verifyEmail);
  const [cooldown, setCooldown] = useState(0);
  const [sent, setSent] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!session.signedIn) {
      void navigate({ to: '/sign-in' });
    }
  }, [session.signedIn, navigate]);

  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  useEffect(() => {
    function onFocus() {
      setChecking(true);
      window.setTimeout(() => {
        verifyEmail();
        void navigate({ to: '/onboarding/team' });
      }, 600);
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [navigate, verifyEmail]);

  return (
    <AuthShell
      title={t('verifyEmail.title')}
      description={t('verifyEmail.description')}
    >
      <div className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4">
        <Mail className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium">{session.email || t('verifyEmail.inboxFallback')}</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {checking ? t('verifyEmail.checking') : sent ? t('verifyEmail.sent') : t('verifyEmail.openLink')}
          </p>
        </div>
      </div>
      <Button
        type="button"
        variant="secondary"
        disabled={cooldown > 0}
        onClick={() => {
          setSent(true);
          setCooldown(30);
        }}
      >
        {cooldown > 0 ? t('verifyEmail.resendIn', { seconds: cooldown }) : t('verifyEmail.resend')}
      </Button>
      <Button
        type="button"
        onClick={() => {
          verifyEmail();
          void navigate({ to: '/onboarding/team' });
        }}
      >
        {t('verifyEmail.verified')}
      </Button>
      <Link to="/sign-up" className="text-[13px] text-muted-foreground hover:text-foreground">
        {t('verifyEmail.differentEmail')}
      </Link>
    </AuthShell>
  );
}
