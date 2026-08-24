import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthShell } from '@/components/auth-shell';
import { Button } from '@/components/ui/button';
import { invitations } from '@/mock/data';
import { useSessionStore } from '@/stores/session-store';

export const Route = createFileRoute('/invite/$token')({
  component: InvitePage,
});

function InvitePage() {
  const { t } = useTranslation('auth');
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const session = useSessionStore();
  const signIn = useSessionStore((state) => state.signIn);
  const setTeam = useSessionStore((state) => state.setTeam);
  const [accepting, setAccepting] = useState(false);

  const invitation = token === invitations.expired.token ? invitations.expired : invitations.valid;
  const mismatch = session.signedIn && session.email && session.email !== invitation.email;

  if (invitation.status === 'expired') {
    return (
      <AuthShell title={t('invite.expiredTitle')} description={t('invite.expiredDescription')}>
        <Button asChild className="w-full">
          <Link to="/sign-in">{t('forgotPassword.returnToSignIn')}</Link>
        </Button>
      </AuthShell>
    );
  }

  if (mismatch) {
    return (
      <AuthShell
        title={t('invite.wrongAccountTitle')}
        description={t('invite.wrongAccountDescription', { email: invitation.email, teamName: invitation.teamName })}
      >
        <Button asChild className="w-full">
          <Link to="/sign-in">{t('invite.switchAccounts')}</Link>
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('invite.joinTitle', { teamName: invitation.teamName })}
      description={t('invite.joinDescription', { email: invitation.email })}
    >
      <Button
        className="w-full"
        disabled={accepting}
        onClick={() => {
          setAccepting(true);
          window.setTimeout(() => {
            if (!session.signedIn) {
              signIn(invitation.email);
            }
            setTeam('acme');
            void navigate({ to: '/$teamSlug/home', params: { teamSlug: 'acme' } });
          }, 400);
        }}
      >
        {accepting ? t('invite.joining') : session.signedIn ? t('invite.join') : t('invite.createAndJoin')}
      </Button>
    </AuthShell>
  );
}
