import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SaveIndicator } from '@/components/save-indicator';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { WorkflowSteps } from '@/components/workflow-steps';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { WorkflowStep } from '@/mock/data';
import { api } from '@/api/client';
import { useAgentsQuery, useWorkflowQuery, workflowsQueryKey } from '@/api/queries';
import { queryClient } from '@/lib/query-client';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/workflows/$workflowId')({
  component: WorkflowEditorPage,
});

function WorkflowEditorPage() {
  const { t } = useTranslation(['workflows', 'common']);
  const { workflowId } = Route.useParams();
  const workspaceSlug = "personal";
  const isNew = workflowId === 'new';
  const { data: existing } = useWorkflowQuery(workspaceSlug, workflowId);
  const { data: availableAgents = [] } = useAgentsQuery(workspaceSlug);
  const [name, setName] = useState(existing?.name ?? t('editor.untitled'));
  const [input, setInput] = useState('topic: daily market brief');
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(steps[0]?.id ?? null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>(isNew ? 'unsaved' : 'saved');
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [publishOpen, setPublishOpen] = useState(false);
  const [runSubmitting, setRunSubmitting] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [logs] = useState([
    { time: '08:12:01', severity: 'info', source: 'run', content: 'Run queued' },
    { time: '08:12:04', severity: 'info', source: 'Researcher', content: 'Step started' },
    { time: '08:14:11', severity: 'info', source: 'Brief writer', content: 'Generating brief' },
  ]);
  const selected = steps.find((step) => step.id === selectedId);
  const navigate = useNavigate();

  const panelOpen = Boolean(selected);

  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setSaveState('saved');
  }, [existing]);

  function reindex(next: WorkflowStep[]) {
    return next.map((step, index) => ({ ...step, position: index + 1 }));
  }

  function addStep(index: number) {
    const agent = availableAgents[0];
    const step: WorkflowStep = {
      id: `step_${Date.now()}`,
      position: index + 1,
      agentId: agent?.id ?? 'agt_researcher',
      agentName: agent?.name ?? 'Researcher',
      agentVersion: agent?.version ?? 'v1',
      inputSummary: 'input → output',
      errorPolicy: 'stop',
    };
    const next = [...steps];
    next.splice(index, 0, step);
    setSteps(reindex(next));
    setSelectedId(step.id);
    setSaveState('unsaved');
  }

  function save() {
    if (saveState === 'saving') return;
    setSaveState('saving');
    setSaveError('');
    const request = isNew ? api.createWorkflow(workspaceSlug, { name }) : api.updateWorkflow(workspaceSlug, workflowId, { name });
    void request.then(async (saved) => {
      setSaveState('saved');
      if (isNew) void navigate({ to: '/workflows/$workflowId', params: { workflowId: saved.id }, replace: true });
      void queryClient.invalidateQueries({ queryKey: workflowsQueryKey() }).catch(() => undefined);
    }).catch((error: unknown) => {
      setSaveState('unsaved');
      setSaveError(error instanceof Error ? error.message : t('editor.saveFailed'));
    });
  }

  async function runWorkflow() {
    if (isNew) {
      toast.message(t('editor.saveBeforeRun'));
      return;
    }
    setRunSubmitting(true);
    try {
      if (!existing?.latestVersionId) {
        toast.error('Save a workflow version before running it.');
        return;
      }
      const result = await api.createRun(existing.latestVersionId, { input });
      void navigate({ to: '/runs/$runId', params: { runId: result.runId } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to start workflow.');
    } finally {
      setRunSubmitting(false);
    }
  }

  function moveStep(id: string, direction: -1 | 1) {
    const index = steps.findIndex((step) => step.id === id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= steps.length) return;
    const next = [...steps];
    const [removed] = next.splice(index, 1);
    next.splice(nextIndex, 0, removed);
    setSteps(reindex(next));
    setSaveState('unsaved');
  }

  const logLines = useMemo(() => logs, [logs]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceChrome
        crumbs={[
          { label: t('title'), to: '/workflows' },
          { label: isNew ? t('editor.new') : existing?.name ?? t('editor.fallback') },
        ]}
        status={<SaveIndicator state={saveState} />}
        actions={
          <>
            <Button asChild variant="ghost" size="compact">
              <Link to="/workflows/$workflowId/versions" params={{ workflowId }}>
                {t('editor.versions')}
              </Link>
            </Button>
            <Button variant="ghost" size="compact" onClick={() => setAiOpen((value) => !value)}>
              {t('editor.aiEdit')}
            </Button>
            <Button variant="secondary" size="compact" onClick={save} disabled={saveState === 'saving'}>
              {t('common:actions.save')}
            </Button>
            <Button variant="secondary" size="compact" onClick={() => void runWorkflow()} disabled={runSubmitting}>
              {runSubmitting ? t('editor.running') : t('editor.run')}
            </Button>
            <Button size="compact" onClick={() => setPublishOpen(true)}>
              {t('common:actions.publish')}
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto px-6 py-6">
          <div className="mx-auto max-w-2xl">
            <Field label={t('editor.name')} htmlFor="wf-name">
              <Input id="wf-name" value={name} onChange={(event) => { setName(event.target.value); setSaveState('unsaved'); }} />
            </Field>
            {saveError ? <p className="mt-2 text-[13px] text-danger" role="alert">{saveError}</p> : null}
            <Field className="mt-4" label={t('editor.input')} htmlFor="wf-input">
              <Textarea id="wf-input" className="font-mono text-[13px]" value={input} onChange={(event) => { setInput(event.target.value); setSaveState('unsaved'); }} />
            </Field>
            <div className="mt-6">
              <WorkflowSteps
                steps={steps}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onAdd={addStep}
                onMove={moveStep}
                onRemove={(id) => {
                  const next = steps.filter((step) => step.id !== id);
                  setSteps(reindex(next));
                  setSelectedId(next[0]?.id ?? null);
                  setSaveState('unsaved');
                }}
              />
            </div>
          </div>
        </div>
        {panelOpen ? (
          <aside className="hidden w-[360px] shrink-0 overflow-auto border-l border-border bg-surface p-4 xl:block">
            <h2 className="text-sm font-semibold">{t('editor.step', { position: selected?.position })}</h2>
            <div className="mt-4 flex flex-col gap-4">
              <Field label={t('editor.agentVersion')} htmlFor="agent">
                <Select
                  value={selected?.agentId}
                  onValueChange={(value) => {
                    const agent = availableAgents.find((item) => item.id === value);
                    setSteps((current) =>
                      current.map((step) =>
                        step.id === selectedId
                          ? { ...step, agentId: value, agentName: agent?.name ?? step.agentName, agentVersion: agent?.version ?? step.agentVersion }
                          : step,
                      ),
                    );
                    setSaveState('unsaved');
                  }}
                >
                  <SelectTrigger id="agent">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableAgents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name} {agent.version}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t('editor.errorPolicy')} htmlFor="policy">
                <Select
                  value={selected?.errorPolicy}
                  onValueChange={(value) => {
                    setSteps((current) =>
                      current.map((step) => (step.id === selectedId ? { ...step, errorPolicy: value as 'stop' | 'retry' } : step)),
                    );
                    setSaveState('unsaved');
                  }}
                >
                  <SelectTrigger id="policy">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stop">{t('editor.stop')}</SelectItem>
                    <SelectItem value="retry">{t('editor.retry')}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <p className="text-[13px] text-muted-foreground">{t('editor.overridesHint')}</p>
            </div>
          </aside>
        ) : null}
        {aiOpen ? (
          <aside className="hidden w-[360px] shrink-0 overflow-auto border-l border-border bg-surface p-4 2xl:block">
            <h2 className="text-sm font-semibold">{t('editor.assistant')}</h2>
            <p className="mt-2 text-[13px] text-muted-foreground">{t('editor.assistantHint')}</p>
            <Textarea className="mt-3" value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} placeholder={t('editor.assistantPlaceholder')} />
            <Button className="mt-3" size="compact" onClick={() => toast.message(t('editor.pendingDescription'))}>
              {t('editor.propose')}
            </Button>
            <div className="mt-4 rounded-lg border border-border p-3 text-[13px]">
              <p className="font-medium">{t('editor.pendingOperation')}</p>
              <p className="mt-1 text-muted-foreground">{t('editor.pendingDescription')}</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => { addStep(steps.length); toast.success(t('editor.applied')); }}>{t('editor.apply')}</Button>
                <Button size="sm" variant="ghost">{t('editor.undo')}</Button>
              </div>
            </div>
          </aside>
        ) : null}
      </div>
      <Collapsible defaultOpen className="hidden border-t border-border md:block">
        <div className="flex h-9 items-center justify-between px-4">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm">{t('editor.runOutput')}</Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="h-48 overflow-auto bg-background px-4 py-3 font-mono text-[12px]">
            {logLines.map((line, index) => (
              <p key={index} className={cn('grid grid-cols-[72px_64px_110px_1fr] gap-3', line.severity === 'error' && 'text-danger')}>
                <span className="text-muted-foreground">{line.time}</span>
                <span>{line.severity}</span>
                <span className="text-muted-foreground">{line.source}</span>
                <span>{line.content}</span>
              </p>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('editor.publishTitle')}</DialogTitle>
            <DialogDescription>
              {t('editor.publishDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPublishOpen(false)}>{t('common:actions.cancel')}</Button>
            <Button
              onClick={() => {
                setPublishOpen(false);
                toast.success(t('editor.published'));
                void navigate({ to: '/workflows' });
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
