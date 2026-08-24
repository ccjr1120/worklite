import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { StatusBadge } from '@/components/status-badge';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatRelativeTime } from '@/i18n/format';
import { members } from '@/mock/data';

export const Route = createFileRoute('/$teamSlug/settings/members')({
  component: MembersSettingsPage,
});

function MembersSettingsPage() {
  const { t } = useTranslation(['settings', 'common']);
  const { locale } = useLocale();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
      <WorkspaceChrome
        crumbs={[{ label: t('nav.title') }, { label: t('nav.members') }]}
        actions={
          <Button size="compact" onClick={() => setOpen(true)}>
            {t('members.invite')}
          </Button>
        }
      />
      <h1 className="text-2xl font-semibold tracking-tight">{t('members.title')}</h1>
      <p className="mt-2 text-[13px] text-muted-foreground">{t('members.description')}</p>
      <div className="mt-6">
        <CollectionTable>
          <CollectionHeader columns={[t('members.columns.member'), t('members.columns.role'), t('members.columns.status'), t('members.columns.lastActive'), t('members.columns.actions')]} />
          {members.map((member) => (
            <CollectionRow key={member.id}>
              <span>
                <span className="block text-sm font-medium">{member.name}</span>
                <span className="text-[13px] text-muted-foreground">{member.email}</span>
              </span>
              <span className="text-[13px]">{t(`common:roles.${member.role}`)}</span>
              <StatusBadge status={member.status === 'active' ? 'completed' : member.status === 'pending' ? 'queued' : 'failed'} />
              <span className="tabular-nums text-[13px] text-muted-foreground">
                {member.lastActive ? formatRelativeTime(member.lastActive, locale) : t('common:empty.dash')}
              </span>
              <span className="flex justify-end gap-1">
                <Button size="sm" variant="ghost" onClick={() => toast.message(t('members.roleChangeConfirm'))}>
                  {t('members.changeRole')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => toast.message(member.status === 'pending' ? t('members.invitationResent') : t('members.memberRetained'))}>
                  {member.status === 'pending' ? t('members.resend') : t('members.remove')}
                </Button>
              </span>
            </CollectionRow>
          ))}
        </CollectionTable>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('members.inviteTitle')}</DialogTitle>
            <DialogDescription>{t('members.inviteDescription')}</DialogDescription>
          </DialogHeader>
          <Field label={t('members.workEmail')} htmlFor="invite-email">
            <Input id="invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Field label={t('members.role')} htmlFor="role">
            <Select defaultValue="member">
              <SelectTrigger id="role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">{t('common:roles.member')}</SelectItem>
                <SelectItem value="admin">{t('common:roles.admin')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>{t('common:actions.cancel')}</Button>
            <Button
              onClick={() => {
                setOpen(false);
                toast.success(t('members.inviteSent'));
                setEmail('');
              }}
            >
              {t('members.sendInvite')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
