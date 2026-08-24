import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SaveIndicator } from '@/components/save-indicator';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { teamBySlug } from '@/mock/data';

export const Route = createFileRoute('/$teamSlug/settings/general')({
  component: GeneralSettingsPage,
});

function GeneralSettingsPage() {
  const { t } = useTranslation(['settings', 'common']);
  const { teamSlug } = Route.useParams();
  const team = teamBySlug(teamSlug);
  const [name, setName] = useState(team?.name ?? '');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="mx-auto w-full max-w-[840px] px-6 py-6">
      <WorkspaceChrome crumbs={[{ label: t('nav.title') }, { label: t('nav.general') }]} status={<SaveIndicator state={saveState} />} />
      <h1 className="text-2xl font-semibold tracking-tight">{t('general.title')}</h1>
      <p className="mt-2 text-[13px] text-muted-foreground">{t('general.description', { team: team?.name })}</p>
      <div className="mt-6 flex flex-col gap-4">
        <Field label={t('general.teamName')} htmlFor="name">
          <Input
            id="name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setSaveState('unsaved');
            }}
          />
        </Field>
        <Field label={t('general.teamIdentifier')} htmlFor="slug" hint={t('general.identifierHint')}>
          <Input id="slug" defaultValue={teamSlug} onChange={() => setSaveState('unsaved')} />
        </Field>
        <Button
          className="w-fit"
          onClick={() => {
            setSaveState('saving');
            window.setTimeout(() => {
              setSaveState('saved');
              toast.success(t('general.saved'));
            }, 400);
          }}
        >
          {t('common:actions.save')}
        </Button>
        <div className="mt-10 rounded-lg border border-danger/30 p-4">
          <h2 className="text-sm font-semibold">{t('general.deleteTitle')}</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">{t('general.deleteDescription')}</p>
          <Button className="mt-3" variant="destructive" onClick={() => setConfirmOpen(true)}>
            {t('general.deleteAction')}
          </Button>
        </div>
      </div>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('general.deleteConfirmTitle', { team: team?.name })}</DialogTitle>
            <DialogDescription>{t('general.deleteConfirmDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>{t('common:actions.cancel')}</Button>
            <Button variant="destructive" onClick={() => { setConfirmOpen(false); toast.error(t('general.deleteGated')); }}>
              {t('common:actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
