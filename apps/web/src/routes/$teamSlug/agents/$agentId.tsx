import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { SaveIndicator } from '@/components/save-indicator';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { agents } from '@/mock/data';
import { useEditorStore } from '@/stores/editor-store';

export const Route = createFileRoute('/$teamSlug/agents/$agentId')({
  component: AgentEditorPage,
});

function AgentEditorPage() {
  const { t } = useTranslation(['agents', 'common']);
  const { teamSlug, agentId } = Route.useParams();
  const isNew = agentId === 'new';
  const existing = agents.find((item) => item.id === agentId);
  const [name, setName] = useState(existing?.name ?? '');
  const [responsibility, setResponsibility] = useState(existing?.responsibility ?? '');
  const [instructions, setInstructions] = useState(
    existing ? `You are ${existing.name}. ${existing.responsibility}. Prefer concise, sourced answers.` : '',
  );
  const [model, setModel] = useState(existing?.model ?? 'claude-sonnet-4');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>(isNew ? 'unsaved' : 'saved');
  const [publishOpen, setPublishOpen] = useState(false);
  const navigate = useNavigate();
  const selectedNodeId = useEditorStore((state) => state.selectedNodeId);

  function markUnsaved() {
    setSaveState('unsaved');
  }

  function save() {
    setSaveState('saving');
    window.setTimeout(() => setSaveState('saved'), 400);
  }

  return (
    <div className="flex h-full min-h-0">
      <WorkspaceChrome
        crumbs={[
          { label: t('title'), to: `/${teamSlug}/agents` },
          { label: isNew ? t('editor.new') : existing?.name ?? t('editor.fallback') },
        ]}
        status={<SaveIndicator state={saveState} />}
        actions={
          <>
            <Button variant="ghost" size="compact" type="button">
              {t('common:actions.preview')}
            </Button>
            <Button variant="secondary" size="compact" type="button" onClick={save} disabled={saveState === 'saving'}>
              {t('common:actions.save')}
            </Button>
            <Button size="compact" type="button" onClick={() => setPublishOpen(true)}>
              {t('common:actions.publish')}
            </Button>
          </>
        }
      />
      <div className="min-w-0 flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <Field label={t('editor.name')} htmlFor="name">
            <Input id="name" value={name} onChange={(event) => { setName(event.target.value); markUnsaved(); }} />
          </Field>
          <Field label={t('editor.responsibility')} htmlFor="responsibility">
            <Input id="responsibility" value={responsibility} onChange={(event) => { setResponsibility(event.target.value); markUnsaved(); }} />
          </Field>
          <Field label={t('editor.instructions')} htmlFor="instructions" hint={t('editor.instructionsHint')}>
            <Textarea
              id="instructions"
              className="min-h-64 font-mono text-[13px]"
              value={instructions}
              onChange={(event) => { setInstructions(event.target.value); markUnsaved(); }}
            />
          </Field>
        </div>
      </div>
      <aside className="hidden w-[360px] shrink-0 overflow-auto border-l border-border bg-surface p-4 lg:block">
        <h2 className="text-sm font-semibold">{t('editor.configuration')}</h2>
        <div className="mt-4 flex flex-col gap-4">
          <Field label={t('editor.model')} htmlFor="model">
            <Select value={model} onValueChange={(value) => { setModel(value); markUnsaved(); }}>
              <SelectTrigger id="model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude-sonnet-4">claude-sonnet-4</SelectItem>
                <SelectItem value="claude-opus-4">claude-opus-4</SelectItem>
                <SelectItem value="gpt-4.1">gpt-4.1</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium">{t('editor.skills')}</legend>
            {['web-search', 'style-guide', 'citations'].map((skill) => (
              <label key={skill} className="flex items-center gap-2 text-[13px]">
                <Checkbox defaultChecked={existing?.skills.includes(skill)} onCheckedChange={markUnsaved} />
                {skill}
              </label>
            ))}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium">{t('editor.mcpServers')}</legend>
            <label className="flex items-center gap-2 text-[13px]">
              <Checkbox defaultChecked onCheckedChange={markUnsaved} />
              Internal docs
            </label>
          </fieldset>
          <p className="text-[13px] text-muted-foreground">
            {t('editor.publishHint')}
            {selectedNodeId ? ` ${t('editor.selectedNode', { id: selectedNodeId })}` : null}
          </p>
        </div>
      </aside>
      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('editor.publishTitle')}</DialogTitle>
            <DialogDescription>{t('editor.publishDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPublishOpen(false)}>{t('common:actions.cancel')}</Button>
            <Button
              onClick={() => {
                setPublishOpen(false);
                toast.success(t('editor.published'));
                void navigate({ to: '/$teamSlug/agents', params: { teamSlug } });
              }}
            >
              {t('common:actions.publish')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
