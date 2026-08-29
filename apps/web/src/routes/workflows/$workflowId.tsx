import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Check, FilePlus2, PanelRight, Plus, Redo2, Search, Settings2, SlidersHorizontal, Undo2 } from 'lucide-react';
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
import { AgentMark } from '@/components/agent-mark';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { WorkflowStep } from '@/mock/data';
import { workflowSteps as seededWorkflowSteps } from '@/mock/data';
import type { WorkflowDefinition, WorkflowEditOperation } from '@worklite/contracts';
import { api } from '@/api/client';
import { useAgentVersionsQuery, useAgentsQuery, useWorkflowQuery, workflowsQueryKey } from '@/api/queries';
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
  const [draftRevisionId, setDraftRevisionId] = useState('');
  const [persistedDefinition, setPersistedDefinition] = useState<WorkflowDefinition>({ schemaVersion: 1, input: {}, defaults: { errorPolicy: 'stop' }, nodes: [] });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [insertIndex, setInsertIndex] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(isNew);
  const [executionPolicy, setExecutionPolicy] = useState<'stop' | 'retry'>('stop');
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
  const selectedAgentVersionsQuery = useAgentVersionsQuery(workspaceSlug, selected?.nodeType === 'agent' ? selected.agentId : '');
  const navigate = useNavigate();

  const panelOpen = Boolean(selected);

  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    if (existing.draft) {
      const definition = existing.draft.definition;
      setSteps(toEditorSteps(definition));
      setSelectedId(definition.nodes[0]?.id ?? null);
      setInsertIndex(definition.nodes.length);
      setInput(typeof definition.input.example === 'string' ? definition.input.example : '');
      setExecutionPolicy(definition.defaults.errorPolicy);
      setDraftRevisionId(existing.draft.revisionId);
      setPersistedDefinition(definition);
      setCanUndo(existing.draft.canUndo);
      setCanRedo(existing.draft.canRedo);
    }
    setSaveState('saved');
  }, [existing]);

  function reindex(next: WorkflowStep[]) {
    return next.map((step, index) => ({ ...step, position: index + 1 }));
  }

  function requestAdd(index: number) {
    setInsertIndex(index);
    setPaletteOpen(true);
  }

  function addStep(index: number, agentId: string) {
    const agent = availableAgents.find((item) => item.id === agentId);
    const step: WorkflowStep = {
      id: `step_${Date.now()}`,
      position: index + 1,
      agentId: agent?.id ?? agentId,
      agentName: agent?.name ?? 'Agent',
      agentVersion: agent?.latestVersion ? `v${agent.latestVersion}` : agent?.version ?? 'draft',
      nodeType: 'agent',
      agentVersionId: agent?.latestVersionId ?? undefined,
      inputSummary: 'input → output',
      errorPolicy: executionPolicy,
    };
    const next = [...steps];
    next.splice(index, 0, step);
    setSteps(reindex(next));
    setSelectedId(step.id);
    setInsertIndex(index + 1);
    setPaletteOpen(false);
    setSaveState('unsaved');
  }

  function addTextStep(index: number) {
    const step: WorkflowStep = {
      id: `text_${Date.now()}`,
      position: index + 1,
      agentId: '',
      agentName: 'Text',
      agentVersion: '1',
      nodeType: 'text',
      text: '',
      outputType: 'text',
      inputSummary: 'literal → output',
      errorPolicy: executionPolicy,
    };
    const next = [...steps];
    next.splice(index, 0, step);
    setSteps(reindex(next));
    setSelectedId(step.id);
    setInsertIndex(index + 1);
    setPaletteOpen(false);
    setSaveState('unsaved');
  }

  function currentDefinition(): WorkflowDefinition {
    return {
      schemaVersion: 1,
      input: input ? { example: input } : {},
      defaults: { errorPolicy: executionPolicy },
      nodes: steps.map((step, index) => ({
        id: step.id,
        position: index + 1,
        type: step.nodeType === 'text' ? 'worklite/text' : 'worklite/agent',
        typeVersion: '1',
        config: step.nodeType === 'text'
          ? { text: step.text ?? '' }
          : { agentId: step.agentId, agentName: step.agentName, agentVersion: step.agentVersion, ...(step.agentVersionId ? { agentVersionId: step.agentVersionId } : {}), ...(step.promptTemplate ? { promptTemplate: step.promptTemplate } : {}), ...(step.outputType === 'file' ? { outputType: 'file', fileName: step.fileName ?? 'workflow-output.txt', fileType: step.fileType ?? 'markdown' } : {}) },
        input: step.nodeType === 'text' ? { source: 'literal' as const, value: step.text ?? '' } : index === 0 ? { source: 'workflow.input' as const } : { source: 'previous.output' as const },
        errorPolicy: step.errorPolicy,
      })),
    };
  }

  function replaceOperations(previous: WorkflowDefinition, next: WorkflowDefinition): WorkflowEditOperation[] {
    return [
      ...previous.nodes.map((node) => ({ type: 'removeNode' as const, nodeId: node.id })),
      ...next.nodes.map((node, index) => ({ type: 'addNode' as const, node, index })),
      { type: 'updateSettings' as const, input: next.input, defaults: next.defaults },
    ];
  }

  function syncDraft(detail: typeof existing) {
    if (!detail?.draft) return;
    const definition = detail.draft.definition;
    setSteps(toEditorSteps(definition));
    setSelectedId(definition.nodes[0]?.id ?? null);
    setInsertIndex(definition.nodes.length);
    setInput(typeof definition.input.example === 'string' ? definition.input.example : '');
    setExecutionPolicy(definition.defaults.errorPolicy);
    setDraftRevisionId(detail.draft.revisionId);
    setPersistedDefinition(definition);
    setCanUndo(detail.draft.canUndo);
    setCanRedo(detail.draft.canRedo);
  }

  function duplicateStep(id: string) {
    const source = steps.find((step) => step.id === id);
    if (!source) return;
    const index = steps.findIndex((step) => step.id === id);
    const duplicate = { ...source, id: `step_${Date.now()}`, position: index + 2 };
    setSteps(reindex([...steps.slice(0, index + 1), duplicate, ...steps.slice(index + 1)]));
    setSelectedId(duplicate.id);
    setInsertIndex(index + 2);
    setSaveState('unsaved');
  }

  async function save() {
    if (saveState === 'saving') return;
    setSaveState('saving');
    setSaveError('');
    try {
      if (isNew) {
        const saved = await api.createWorkflow(workspaceSlug, { name, definition: currentDefinition() });
        syncDraft(saved);
        setSaveState('saved');
        void navigate({ to: '/workflows/$workflowId', params: { workflowId: saved.id }, replace: true });
        return;
      }
      await api.updateWorkflow(workspaceSlug, workflowId, { name });
      const saved = await api.applyWorkflowOperations(workspaceSlug, workflowId, { baseRevisionId: draftRevisionId, operations: replaceOperations(persistedDefinition, currentDefinition()) });
      syncDraft(saved);
      setSaveState('saved');
      void queryClient.invalidateQueries({ queryKey: workflowsQueryKey() }).catch(() => undefined);
    } catch (error: unknown) {
      setSaveState('unsaved');
      setSaveError(error instanceof Error ? error.message : t('editor.saveFailed'));
    }
  }

  async function moveRevision(direction: 'undo' | 'redo') {
    if (isNew || saveState === 'saving') return;
    setSaveState('saving');
    try {
      const saved = direction === 'undo' ? await api.undoWorkflow(workspaceSlug, workflowId) : await api.redoWorkflow(workspaceSlug, workflowId);
      syncDraft(saved);
      setSaveState('saved');
    } catch (error) {
      setSaveState('unsaved');
      setSaveError(error instanceof Error ? error.message : t('editor.saveFailed'));
    }
  }

  async function publishWorkflow() {
    if (isNew) {
      toast.message(t('editor.saveBeforeRun'));
      return;
    }
    if (saveState !== 'saved') {
      toast.message(t('editor.saveBeforePublish'));
      return;
    }
    setPublishOpen(false);
    try {
      await api.publishWorkflow(workspaceSlug, workflowId);
      await queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
      await queryClient.invalidateQueries({ queryKey: workflowsQueryKey() });
      toast.success(t('editor.published'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('editor.publishFailed'));
    }
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
  const filteredAgents = useMemo(() => {
    const query = paletteQuery.trim().toLowerCase();
    if (!query) return availableAgents;
    return availableAgents.filter((agent) => `${agent.name} ${agent.responsibility} ${agent.model}`.toLowerCase().includes(query));
  }, [availableAgents, paletteQuery]);

  const insertionLabel = steps.length === 0
    ? t('editor.insertFirst')
    : t('editor.insertAt', { position: insertIndex + 1 });

  function applyTemplate(template: 'blank' | 'daily') {
    if (template === 'blank') {
      setName(t('editor.untitled'));
      setInput('');
      setSteps([]);
      setSelectedId(null);
      setInsertIndex(0);
    } else {
      const source = seededWorkflowSteps.wf_daily_brief ?? [];
      const next = source.map((step, index) => ({ ...step, id: `step_${Date.now()}_${index}`, position: index + 1 }));
      setName(t('editor.templateDailyName'));
      setInput('topic: daily market brief');
      setSteps(next);
      setSelectedId(next[0]?.id ?? null);
      setInsertIndex(next.length);
    }
    setSaveState('unsaved');
    setTemplateOpen(false);
  }

  const palette = (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t('editor.agentPalette')}</h2>
          <p className="mt-1 text-[12px] text-muted-foreground">{insertionLabel}</p>
        </div>
        <FilePlus2 className="size-4 text-muted-foreground" aria-hidden="true" />
      </div>
      <label className="relative mt-4 block">
        <span className="sr-only">{t('editor.searchAgents')}</span>
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
        <Input className="pl-8" value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} placeholder={t('editor.searchAgents')} />
      </label>
      <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-auto">
        <button type="button" className="flex w-full items-center gap-3 rounded-md border border-transparent px-2 py-2 text-left transition-colors duration-[120ms] hover:border-border hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45" onClick={() => addTextStep(insertIndex)}>
          <FilePlus2 className="size-5 shrink-0 text-brand" />
          <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">Text</span><span className="block truncate text-[12px] text-muted-foreground">Literal text input</span></span>
          <Plus className="size-4 text-muted-foreground" aria-hidden="true" />
        </button>
        {filteredAgents.length === 0 ? <p className="px-2 py-6 text-center text-[13px] text-muted-foreground">{t('editor.noAgents')}</p> : null}
        {filteredAgents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className="flex w-full items-center gap-3 rounded-md border border-transparent px-2 py-2 text-left transition-colors duration-[120ms] hover:border-border hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45"
            onClick={() => addStep(insertIndex, agent.id)}
          >
            <AgentMark initials={agent.initials ?? agent.name.slice(0, 2).toUpperCase()} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{agent.name}</span>
              <span className="block truncate text-[12px] text-muted-foreground">{agent.model}</span>
            </span>
            <Plus className="size-4 text-muted-foreground" aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );

  const inspector = selected ? (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t('editor.step', { position: selected.position })}</p>
          <h2 className="mt-1 text-sm font-semibold">{selected.agentName}</h2>
        </div>
        <PanelRight className="size-4 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="mt-5 flex flex-col gap-4">
        {selected.nodeType === 'text' ? <Field label="Text" htmlFor="node-text"><Textarea id="node-text" value={selected.text ?? ''} onChange={(event) => { setSteps((current) => current.map((step) => step.id === selectedId ? { ...step, text: event.target.value, inputSummary: event.target.value ? 'literal → output' : 'empty literal → output' } : step)); setSaveState('unsaved'); }} placeholder="Enter text" /></Field> : (
          <>
            <Field label="Agent" htmlFor="agent">
              <Select
                value={selected.agentId}
                onValueChange={(value) => {
                  const agent = availableAgents.find((item) => item.id === value);
                  setSteps((current) => current.map((step) => step.id === selectedId ? {
                    ...step,
                    agentId: value,
                    agentName: agent?.name ?? step.agentName,
                    agentVersion: agent?.latestVersion ? `v${agent.latestVersion}` : agent?.version ?? step.agentVersion,
                    agentVersionId: agent?.latestVersionId ?? undefined,
                  } : step));
                  setSaveState('unsaved');
                }}
              >
                <SelectTrigger id="agent"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {availableAgents.map((agent) => <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('editor.agentVersion')} htmlFor="agent-version">
              <Select
                value={selected.agentVersionId}
                onValueChange={(value) => {
                  const version = selectedAgentVersionsQuery.data?.find((item) => item.id === value);
                  setSteps((current) => current.map((step) => step.id === selectedId ? { ...step, agentVersionId: value, agentVersion: version ? `v${version.version}` : step.agentVersion } : step));
                  setSaveState('unsaved');
                }}
                disabled={selectedAgentVersionsQuery.isLoading || selectedAgentVersionsQuery.isError || !(selectedAgentVersionsQuery.data?.length)}
              >
                <SelectTrigger id="agent-version"><SelectValue placeholder={selectedAgentVersionsQuery.isLoading ? 'Loading versions...' : 'Select an immutable version'} /></SelectTrigger>
                <SelectContent>
                  {(selectedAgentVersionsQuery.data ?? []).map((version) => <SelectItem key={version.id} value={version.id}>v{version.version} · {version.model}</SelectItem>)}
                </SelectContent>
              </Select>
              {!selected.agentVersionId ? <p className="mt-1 text-[12px] text-danger">Select an immutable AgentVersion before publishing.</p> : null}
            </Field>
          </>
        )}
        <Field label={t('editor.errorPolicy')} htmlFor="policy">
          <Select
            value={selected.errorPolicy}
            onValueChange={(value) => {
              setSteps((current) => current.map((step) => step.id === selectedId ? { ...step, errorPolicy: value as 'stop' | 'retry' } : step));
              setSaveState('unsaved');
            }}
          >
            <SelectTrigger id="policy"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="stop">{t('editor.stop')}</SelectItem>
              <SelectItem value="retry">{t('editor.retry')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <div className="rounded-md border border-border bg-surface-subtle p-3">
          <p className="text-[12px] font-medium">{t('editor.inputMapping')}</p>
          <p className="mt-1 font-mono text-[12px] text-muted-foreground">{selected.inputSummary}</p>
        </div>
        <p className="text-[13px] text-muted-foreground">{t('editor.overridesHint')}</p>
      </div>
    </div>
  ) : (
    <div className="flex h-full min-h-32 items-center justify-center text-center text-[13px] text-muted-foreground">{t('editor.selectStep')}</div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceChrome
        back={<Button variant="ghost" size="icon-compact" type="button" aria-label={t('common:actions.back')} onClick={() => void navigate({ to: '/workflows' })}><ArrowLeft className="size-4" /></Button>}
        crumbs={[
          { label: t('title'), to: '/workflows' },
          { label: isNew ? t('editor.new') : existing?.name ?? t('editor.fallback') },
        ]}
        status={<SaveIndicator state={saveState} />}
        actions={
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="icon-compact" className="lg:hidden" type="button" aria-label={t('editor.agentPalette')} onClick={() => setPaletteOpen(true)}><Plus className="size-4" /></Button>
            <Button variant="ghost" size="icon-compact" className="xl:hidden" type="button" aria-label={t('editor.configureStep')} onClick={() => setInspectorOpen(true)} disabled={!selected}><PanelRight className="size-4" /></Button>
            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-compact" type="button" aria-label={t('editor.undo')} onClick={() => void moveRevision('undo')} disabled={!canUndo || saveState === 'saving'}><Undo2 className="size-4" /></Button></TooltipTrigger><TooltipContent>{t('editor.undo')}</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-compact" type="button" aria-label={t('editor.redo')} onClick={() => void moveRevision('redo')} disabled={!canRedo || saveState === 'saving'}><Redo2 className="size-4" /></Button></TooltipTrigger><TooltipContent>{t('editor.redo')}</TooltipContent></Tooltip>
            <Button variant="ghost" size="compact" onClick={() => setSettingsOpen(true)}><SlidersHorizontal className="size-4" />{t('editor.workflowSettings')}</Button>
            <Button asChild variant="ghost" size="compact" className="hidden sm:inline-flex">
              <Link to="/workflows/$workflowId/versions" params={{ workflowId }}>
                {t('editor.versions')}
              </Link>
            </Button>
            <Button variant="ghost" size="compact" className="hidden md:inline-flex" onClick={() => setAiOpen((value) => !value)}>
              {t('editor.aiEdit')}
            </Button>
            <Button variant="secondary" size="compact" className="hidden sm:inline-flex" onClick={save} disabled={saveState === 'saving'}>
              {t('common:actions.save')}
            </Button>
            <Button variant="secondary" size="compact" className="hidden sm:inline-flex" onClick={() => void runWorkflow()} disabled={runSubmitting}>
              {runSubmitting ? t('editor.running') : t('editor.run')}
            </Button>
            <Button size="compact" onClick={() => setPublishOpen(true)}>
              {t('common:actions.publish')}
            </Button>
          </div>
        }
      />
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 overflow-auto border-r border-border bg-surface p-4 lg:flex">{palette}</aside>
        <main className="min-w-0 flex-1 overflow-auto">
          <div className="border-b border-border bg-surface px-4 py-3 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-muted-foreground">{t('editor.sequence')}</p>
                <p className="mt-1 text-[13px] text-muted-foreground">{t('editor.stepCount', { count: steps.length })}</p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="compact" className="sm:hidden" onClick={save} disabled={saveState === 'saving'}><Check className="size-4" />{t('common:actions.save')}</Button>
                <Button variant="secondary" size="compact" className="sm:hidden" onClick={() => void runWorkflow()} disabled={runSubmitting}>{t('editor.run')}</Button>
              </div>
            </div>
          </div>
          <div className="px-4 py-6 sm:px-6">
            {saveError ? <p className="mb-4 text-[13px] text-danger" role="alert">{saveError}</p> : null}
            <WorkflowSteps
              steps={steps}
              selectedId={selectedId}
              onSelect={(id) => {
                const step = steps.find((item) => item.id === id);
                setSelectedId(id);
                setInsertIndex(step?.position ?? steps.length);
              }}
              onAdd={requestAdd}
              onMove={moveStep}
              onDuplicate={duplicateStep}
              onRemove={(id) => {
                const next = steps.filter((step) => step.id !== id);
                setSteps(reindex(next));
                setSelectedId(next[0]?.id ?? null);
                setInsertIndex(Math.min(insertIndex, next.length));
                setSaveState('unsaved');
              }}
            />
          </div>
        </main>
        {panelOpen ? <aside className="hidden w-[360px] shrink-0 overflow-auto border-l border-border bg-surface p-4 xl:block">{inspector}</aside> : null}
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
                <Button size="sm" onClick={() => { requestAdd(steps.length); toast.success(t('editor.applied')); }}>{t('editor.apply')}</Button>
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
      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('editor.chooseTemplate')}</DialogTitle>
            <DialogDescription>{t('editor.chooseTemplateDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" className="rounded-lg border border-border bg-surface p-4 text-left transition-colors duration-[120ms] hover:border-brand hover:bg-brand-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45" onClick={() => applyTemplate('blank')}>
              <p className="text-sm font-semibold">{t('editor.blankTemplate')}</p>
              <p className="mt-1 text-[13px] text-muted-foreground">{t('editor.blankTemplateDescription')}</p>
            </button>
            <button type="button" className="rounded-lg border border-border bg-surface p-4 text-left transition-colors duration-[120ms] hover:border-brand hover:bg-brand-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45" onClick={() => applyTemplate('daily')}>
              <p className="text-sm font-semibold">{t('editor.dailyTemplate')}</p>
              <p className="mt-1 text-[13px] text-muted-foreground">{t('editor.dailyTemplateDescription')}</p>
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>{t('editor.workflowSettings')}</DialogTitle>
            <DialogDescription>{t('editor.workflowSettingsDescription')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-5">
            <section>
              <h3 className="text-sm font-semibold">{t('editor.general')}</h3>
              <Field className="mt-3" label={t('editor.name')} htmlFor="wf-name">
                <Input id="wf-name" value={name} onChange={(event) => { setName(event.target.value); setSaveState('unsaved'); }} />
              </Field>
            </section>
            <section>
              <h3 className="text-sm font-semibold">{t('editor.inputs')}</h3>
              <Field className="mt-3" label={t('editor.input')} htmlFor="wf-input">
                <Textarea id="wf-input" className="font-mono text-[13px]" value={input} onChange={(event) => { setInput(event.target.value); setSaveState('unsaved'); }} />
              </Field>
            </section>
            <section>
              <h3 className="text-sm font-semibold">{t('editor.execution')}</h3>
              <Field className="mt-3" label={t('editor.defaultErrorPolicy')} htmlFor="default-policy">
                <Select value={executionPolicy} onValueChange={(value) => { setExecutionPolicy(value as 'stop' | 'retry'); setSaveState('unsaved'); }}>
                  <SelectTrigger id="default-policy"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="stop">{t('editor.stop')}</SelectItem><SelectItem value="retry">{t('editor.retry')}</SelectItem></SelectContent>
                </Select>
              </Field>
            </section>
            <section className="rounded-md border border-border bg-surface-subtle p-3">
              <h3 className="text-sm font-semibold">{t('editor.versioning')}</h3>
              <p className="mt-1 text-[13px] text-muted-foreground">{t('editor.versioningHint')}</p>
            </section>
          </div>
          <DialogFooter>
            <Button onClick={() => setSettingsOpen(false)}>{t('common:actions.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Sheet open={paletteOpen} onOpenChange={setPaletteOpen}>
        <SheetContent side="left" className="p-4 pt-5"><SheetHeader className="p-0 pr-10"><SheetTitle>{t('editor.agentPalette')}</SheetTitle><SheetDescription>{insertionLabel}</SheetDescription></SheetHeader><div className="mt-4 min-h-0 flex-1">{palette}</div></SheetContent>
      </Sheet>
      <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
        <SheetContent side="right" className="overflow-auto p-4 pt-5"><SheetHeader className="sr-only"><SheetTitle>{t('editor.configureStep')}</SheetTitle><SheetDescription>{t('editor.selectStep')}</SheetDescription></SheetHeader>{inspector}</SheetContent>
      </Sheet>
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
              onClick={() => void publishWorkflow()}
            >
              {t('common:actions.publish')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function toEditorSteps(definition: WorkflowDefinition): WorkflowStep[] {
  return definition.nodes.map((node) => {
    const config = node.config && typeof node.config === 'object' && !Array.isArray(node.config) ? node.config as Record<string, unknown> : {};
    const agentId = typeof config.agentId === 'string' ? config.agentId : node.id;
    const agentName = typeof config.agentName === 'string' ? config.agentName : agentId;
    const agentVersion = typeof config.agentVersion === 'string' ? config.agentVersion : 'draft';
    const inputSummary = node.input.source === 'literal' ? 'literal → output' : node.input.source === 'workflow.input' ? 'input → output' : 'previous output → output';
    const nodeType = node.type === 'worklite/text' ? 'text' : 'agent';
    const text = typeof config.text === 'string' ? config.text : node.input.source === 'literal' && typeof node.input.value === 'string' ? node.input.value : '';
    return { id: node.id, position: node.position, agentId, agentName: nodeType === 'text' ? 'Text' : agentName, agentVersion, agentVersionId: typeof config.agentVersionId === 'string' ? config.agentVersionId : undefined, nodeType, text, outputType: config.outputType === 'file' ? 'file' : nodeType === 'text' ? 'text' : undefined, fileName: typeof config.fileName === 'string' ? config.fileName : undefined, fileType: config.fileType === 'json' || config.fileType === 'text' || config.fileType === 'markdown' ? config.fileType : undefined, promptTemplate: typeof config.promptTemplate === 'string' ? config.promptTemplate : undefined, inputSummary, errorPolicy: node.errorPolicy };
  });
}
