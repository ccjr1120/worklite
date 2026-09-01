import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { addEdge, Background, BackgroundVariant, Controls, MarkerType, PanOnScrollMode, ReactFlow, reconnectEdge, useEdgesState, useNodesState, type OnConnect, type OnConnectEnd, type OnReconnect, type ReactFlowInstance } from '@xyflow/react';
import { ArrowLeft, Bot, Braces, Check, Copy, FilePlus2, PanelRight, Plus, Redo2, Search, SlidersHorizontal, Trash2, Undo2, Workflow, Wrench } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { WorkflowDefinition, WorkflowEditOperation, WorkflowNodeDefinition } from '@worklite/contracts';
import { SaveIndicator } from '@/components/save-indicator';
import { useTheme } from '@/components/theme-provider';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { workflowNodeTypes, type WorkflowCanvasEdge, type WorkflowCanvasNode } from '@/components/workflow-canvas-nodes';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { api } from '@/api/client';
import { useAgentVersionsQuery, useAgentsQuery, useSkillsQuery, useWorkflowQuery, workflowsQueryKey } from '@/api/queries';
import { queryClient } from '@/lib/query-client';

export const Route = createFileRoute('/workflows/$workflowId')({
  component: WorkflowEditorPage,
});

const emptyDefinition: WorkflowDefinition = {
  schemaVersion: 3,
  input: {},
  defaults: { errorPolicy: 'stop' },
  nodes: [],
  edges: [],
};

function WorkflowEditorPage() {
  const { t } = useTranslation(['workflows', 'common']);
  const { resolvedTheme } = useTheme();
  const { workflowId } = Route.useParams();
  const workspaceSlug = 'personal';
  const isNew = workflowId === 'new';
  const { data: existing } = useWorkflowQuery(workspaceSlug, workflowId);
  const { data: availableAgents = [] } = useAgentsQuery(workspaceSlug);
  const { data: availableSkills = [] } = useSkillsQuery(workspaceSlug);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowCanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<WorkflowCanvasEdge>([]);
  const [name, setName] = useState(existing?.name ?? t('editor.untitled'));
  const [input, setInput] = useState(() => t('editor.templateDailyInput'));
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>(isNew ? 'unsaved' : 'saved');
  const [draftRevisionId, setDraftRevisionId] = useState('');
  const [persistedDefinition, setPersistedDefinition] = useState<WorkflowDefinition>(emptyDefinition);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [contextPanelOpen, setContextPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(isNew);
  const [executionPolicy, setExecutionPolicy] = useState<'stop' | 'retry'>('stop');
  const [publishOpen, setPublishOpen] = useState(false);
  const [runSubmitting, setRunSubmitting] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<WorkflowCanvasNode, WorkflowCanvasEdge> | null>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const navigate = useNavigate();

  const updateText = useCallback((nodeId: string, value: string) => {
    setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, text: value } } : node));
    setSaveState('unsaved');
  }, [setNodes]);

  const hydrateDefinition = useCallback((definition: WorkflowDefinition, preferredNodeId?: string | null) => {
    const nextNodes = toFlowNodes(definition, updateText);
    const nextEdges = toFlowEdges(definition);
    const nextSelection = preferredNodeId && nextNodes.some((node) => node.id === preferredNodeId) ? preferredNodeId : null;
    setNodes(nextNodes.map((node) => ({ ...node, selected: node.id === nextSelection })));
    setEdges(nextEdges.map((edge) => ({ ...edge, selected: false })));
  }, [setEdges, setNodes, updateText]);

  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    if (existing.draft) {
      const definition = existing.draft.definition;
      hydrateDefinition(definition);
      setInput(typeof definition.input.example === 'string' ? definition.input.example : '');
      setExecutionPolicy(definition.defaults.errorPolicy);
      setDraftRevisionId(existing.draft.revisionId);
      setPersistedDefinition(definition);
      setCanUndo(existing.draft.canUndo);
      setCanRedo(existing.draft.canRedo);
    }
    setSaveState('saved');
  }, [existing, hydrateDefinition]);

  useEffect(() => {
    const desktopPanel = window.matchMedia('(min-width: 1024px)');
    const closeSheetForDesktop = () => {
      if (desktopPanel.matches) setContextPanelOpen(false);
    };
    closeSheetForDesktop();
    desktopPanel.addEventListener('change', closeSheetForDesktop);
    return () => desktopPanel.removeEventListener('change', closeSheetForDesktop);
  }, []);

  const selectedNode = nodes.find((node) => node.selected);
  const selectedEdge = edges.find((edge) => edge.selected);
  const selectedAgentVersionsQuery = useAgentVersionsQuery(workspaceSlug, selectedNode?.data.nodeType === 'generic-agent' ? selectedNode.data.agentId ?? '' : '');
  const publishedAgents = useMemo(() => availableAgents.filter((agent) => Boolean(agent.latestVersionId)), [availableAgents]);
  const filteredAgents = useMemo(() => {
    const query = paletteQuery.trim().toLowerCase();
    if (!query) return publishedAgents;
    return publishedAgents.filter((agent) => `${agent.name} ${agent.responsibility} ${agent.model}`.toLowerCase().includes(query));
  }, [paletteQuery, publishedAgents]);

  function currentDefinition(): WorkflowDefinition {
    return {
      schemaVersion: 3,
      input: input ? { example: input } : {},
      defaults: { errorPolicy: executionPolicy },
      nodes: nodes.map(toDefinitionNode),
      edges: edges.map((edge) => ({ id: edge.id, sourceNodeId: edge.source, sourcePort: edge.sourceHandle ?? 'output', targetNodeId: edge.target, targetPort: edge.targetHandle ?? 'input' })),
    };
  }

  function replaceOperations(previous: WorkflowDefinition, next: WorkflowDefinition): WorkflowEditOperation[] {
    return [
      ...previous.edges.map((edge) => ({ type: 'removeEdge' as const, edgeId: edge.id })),
      ...previous.nodes.map((node) => ({ type: 'removeNode' as const, nodeId: node.id })),
      ...next.nodes.map((node, index) => ({ type: 'addNode' as const, node, index })),
      ...next.edges.map((edge) => ({ type: 'addEdge' as const, edge })),
      { type: 'updateSettings' as const, input: next.input, defaults: next.defaults },
    ];
  }

  function syncDraft(detail: typeof existing, preferredNodeId?: string | null) {
    if (!detail?.draft) return;
    const definition = detail.draft.definition;
    hydrateDefinition(definition, preferredNodeId);
    setInput(typeof definition.input.example === 'string' ? definition.input.example : '');
    setExecutionPolicy(definition.defaults.errorPolicy);
    setDraftRevisionId(detail.draft.revisionId);
    setPersistedDefinition(definition);
    setCanUndo(detail.draft.canUndo);
    setCanRedo(detail.draft.canRedo);
  }

  function nextPosition() {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (flowInstance && bounds) return flowInstance.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
    return { x: 80 + nodes.length * 48, y: 80 + nodes.length * 36 };
  }

  function selectOnlyNode(nodeId: string) {
    setNodes((current) => current.map((node) => ({ ...node, selected: node.id === nodeId })));
    setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
    if (!window.matchMedia('(min-width: 1024px)').matches) setContextPanelOpen(true);
  }

  function selectOnlyEdge(edgeId: string) {
    setNodes((current) => current.map((node) => ({ ...node, selected: false })));
    setEdges((current) => current.map((edge) => ({ ...edge, selected: edge.id === edgeId })));
    if (!window.matchMedia('(min-width: 1024px)').matches) setContextPanelOpen(true);
  }

  function showNodePalette() {
    setNodes((current) => current.map((node) => ({ ...node, selected: false })));
    setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
  }

  const handleConnect: OnConnect = useCallback((connection) => {
    if (!canConnect(connection, nodes, edges)) {
      toast.error(t('editor.invalidConnection'));
      return;
    }
    setEdges((current) => addEdge({ ...connection, id: createId('edge'), type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed }, selected: false }, current.map((edge) => ({ ...edge, selected: false }))));
    setSaveState('unsaved');
  }, [edges, nodes, setEdges, t]);

  const handleConnectEnd: OnConnectEnd = useCallback((_event, connectionState) => {
    if (connectionState.toNode && connectionState.isValid === false) toast.error(t('editor.invalidConnection'));
  }, [t]);

  const handleReconnect: OnReconnect = useCallback((oldEdge, connection) => {
    const nextEdges = reconnectEdge(oldEdge, connection, edges);
    if (!canConnect(connection, nodes, nextEdges.filter((edge) => edge.id !== oldEdge.id))) {
      toast.error(t('editor.invalidConnection'));
      return;
    }
    setEdges(nextEdges.map((edge) => ({ ...edge, type: edge.type ?? 'smoothstep', markerEnd: edge.markerEnd ?? { type: MarkerType.ArrowClosed }, selected: false })));
    setSaveState('unsaved');
  }, [edges, nodes, setEdges, t]);

  function addInputNode() {
    const id = createId('input');
    const node: WorkflowCanvasNode = {
      id,
      type: 'input',
      position: nextPosition(),
      selected: true,
      data: { nodeType: 'input', label: t('editor.workflowInputNode'), errorPolicy: executionPolicy, onTextChange: updateText },
    };
    addNode(node);
  }

  function addTextNode() {
    const id = createId('text');
    const node: WorkflowCanvasNode = {
      id,
      type: 'text',
      position: nextPosition(),
      selected: true,
      data: { nodeType: 'text', label: t('editor.systemPromptNode'), text: '', outputType: 'text', errorPolicy: executionPolicy, onTextChange: updateText },
    };
    addNode(node);
  }

  function addSkillSetNode() {
    const id = createId('skills');
    const node: WorkflowCanvasNode = {
      id,
      type: 'skill-set',
      position: nextPosition(),
      selected: true,
      data: { nodeType: 'skill-set', label: t('editor.skillSetNode'), skillIds: [], skillNames: [], errorPolicy: executionPolicy, onTextChange: updateText },
    };
    addNode(node);
  }

  function addGenericAgentNode(agentId: string) {
    const agent = availableAgents.find((item) => item.id === agentId);
    if (!agent?.latestVersionId) return;
    const id = createId('generic-agent');
    const node: WorkflowCanvasNode = {
      id,
      type: 'generic-agent',
      position: nextPosition(),
      selected: true,
      data: { nodeType: 'generic-agent', label: agent.name, agentId: agent.id, agentVersion: agent.latestVersion ? `v${agent.latestVersion}` : agent.version, agentVersionId: agent.latestVersionId, errorPolicy: executionPolicy, onTextChange: updateText },
    };
    addNode(node);
  }

  function addNode(node: WorkflowCanvasNode) {
    setNodes((current) => [...current.map((item) => ({ ...item, selected: false })), node]);
    setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
    setSaveState('unsaved');
  }

  function removeNode(nodeId: string) {
    setNodes((current) => current.filter((node) => node.id !== nodeId));
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
    setSaveState('unsaved');
  }

  function duplicateNode(nodeId: string) {
    const source = nodes.find((node) => node.id === nodeId);
    if (!source) return;
    const id = createId(source.data.nodeType);
    const duplicate: WorkflowCanvasNode = { ...source, id, position: { x: source.position.x + 40, y: source.position.y + 40 }, selected: true, data: { ...source.data, onTextChange: updateText } };
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), duplicate]);
    setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
    setSaveState('unsaved');
  }

  function removeEdge(edgeId: string) {
    setEdges((current) => current.filter((edge) => edge.id !== edgeId));
    setSaveState('unsaved');
  }

  async function save() {
    if (saveState === 'saving') return;
    setSaveState('saving');
    setSaveError('');
    try {
      const definition = currentDefinition();
      if (isNew) {
        const saved = await api.createWorkflow(workspaceSlug, { name, definition });
        syncDraft(saved, selectedNode?.id);
        setSaveState('saved');
        void navigate({ to: '/workflows/$workflowId', params: { workflowId: saved.id }, replace: true });
        return;
      }
      await api.updateWorkflow(workspaceSlug, workflowId, { name });
      const saved = await api.applyWorkflowOperations(workspaceSlug, workflowId, { baseRevisionId: draftRevisionId, operations: replaceOperations(persistedDefinition, definition) });
      syncDraft(saved, selectedNode?.id);
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
    if (isNew || saveState !== 'saved') {
      toast.message(isNew ? t('editor.saveBeforeRun') : t('editor.saveBeforePublish'));
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
    if (isNew || saveState !== 'saved') {
      toast.message(t('editor.saveBeforeRun'));
      return;
    }
    setRunSubmitting(true);
    try {
      if (!existing?.latestVersionId) {
        toast.error(t('editor.publishBeforeRun'));
        return;
      }
      const result = await api.createRun(existing.latestVersionId, { input });
      void navigate({ to: '/runs/$runId', params: { runId: result.runId } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('editor.runFailed'));
    } finally {
      setRunSubmitting(false);
    }
  }

  function applyTemplate(template: 'blank' | 'daily') {
    if (template === 'blank') {
      setName(t('editor.untitled'));
      setInput('');
      setNodes([]);
      setEdges([]);
    } else {
      const agent = publishedAgents[0];
      if (!agent?.latestVersionId) return;
      const inputNodeId = createId('input');
      const promptNodeId = createId('text');
      const agentNodeId = createId('generic-agent');
      const templateNodes: WorkflowCanvasNode[] = [
        { id: inputNodeId, type: 'input', position: { x: 80, y: 80 }, selected: true, data: { nodeType: 'input', label: t('editor.workflowInputNode'), errorPolicy: executionPolicy, onTextChange: updateText } },
        { id: promptNodeId, type: 'text', position: { x: 80, y: 240 }, data: { nodeType: 'text', label: t('editor.systemPromptNode'), text: t('editor.dailyTemplatePrompt'), errorPolicy: executionPolicy, onTextChange: updateText } },
        { id: agentNodeId, type: 'generic-agent', position: { x: 440, y: 140 }, data: { nodeType: 'generic-agent', label: agent.name, agentId: agent.id, agentVersion: `v${agent.latestVersion}`, agentVersionId: agent.latestVersionId, errorPolicy: executionPolicy, onTextChange: updateText } },
      ];
      const templateEdges: WorkflowCanvasEdge[] = [
        { id: createId('edge'), source: inputNodeId, sourceHandle: 'output', target: agentNodeId, targetHandle: 'context', type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } },
        { id: createId('edge'), source: promptNodeId, sourceHandle: 'output', target: agentNodeId, targetHandle: 'systemPrompt', type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } },
      ];
      setName(t('editor.templateDailyName'));
      setInput(t('editor.templateDailyInput'));
      setNodes(templateNodes);
      setEdges(templateEdges);
    }
    setSaveState('unsaved');
    setTemplateOpen(false);
  }

  const palette = (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
      <div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">{t('editor.nodePalette')}</h2><p className="mt-1 text-[12px] text-muted-foreground">{t('editor.paletteHint')}</p></div><FilePlus2 className="size-4 text-muted-foreground" aria-hidden="true" /></div>
      <label className="relative mt-4 block"><span className="sr-only">{t('editor.searchNodes')}</span><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" /><Input className="pl-8" value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} placeholder={t('editor.searchNodes')} /></label>
      <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-auto">
        <PaletteButton icon={<Braces className="size-5 text-info" />} title={t('editor.workflowInputNode')} description={t('editor.runPayload')} onClick={addInputNode} />
        <PaletteButton icon={<FilePlus2 className="size-5 text-brand" />} title={t('editor.systemPromptNode')} description={t('editor.systemPromptSource')} onClick={addTextNode} />
        <PaletteButton icon={<Wrench className="size-5 text-warning" />} title={t('editor.skillSetNode')} description={t('editor.skillSetDescription')} onClick={addSkillSetNode} />
        {publishedAgents.length === 0 ? <p className="px-2 py-6 text-center text-[13px] text-muted-foreground">{t('editor.noPublishedAgents')}</p> : filteredAgents.length === 0 ? <p className="px-2 py-6 text-center text-[13px] text-muted-foreground">{t('editor.noAgents')}</p> : null}
        {filteredAgents.map((agent) => <PaletteButton key={agent.id} icon={<Bot className="size-5 text-info" />} title={agent.name} description={`${t('editor.genericAgentNode')} · ${agent.model}`} onClick={() => addGenericAgentNode(agent.id)} />)}
      </div>
    </div>
  );

  const inspector = selectedNode ? (
    <div className="flex min-h-0 w-full min-w-0 flex-col">
      <div className="flex items-start gap-2"><Button type="button" variant="ghost" size="icon-compact" aria-label={t('editor.nodePalette')} onClick={showNodePalette}><ArrowLeft className="size-4" /></Button><div className="min-w-0 flex-1"><p className="text-xs font-medium text-muted-foreground">{nodeTypeLabel(selectedNode.data.nodeType, t)}</p><h2 className="mt-1 truncate text-sm font-semibold">{selectedNode.data.label}</h2></div><PanelRight className="mt-2 size-4 text-muted-foreground" aria-hidden="true" /></div>
      <div className="mt-5 flex flex-col gap-4">
        <Field label={t('editor.nodeName')} htmlFor="node-name"><Input id="node-name" value={selectedNode.data.label} onChange={(event) => { const label = event.target.value; setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, label } } : node)); setSaveState('unsaved'); }} /></Field>
        {selectedNode.data.nodeType === 'text' ? <Field label={t('editor.systemPromptNode')} htmlFor="node-text"><Textarea id="node-text" value={selectedNode.data.text ?? ''} onChange={(event) => updateText(selectedNode.id, event.target.value)} placeholder={t('editor.textPlaceholder')} /></Field> : null}
        {selectedNode.data.nodeType === 'skill-set' ? <div><p className="text-[12px] font-medium">{t('editor.skills')}</p><div className="mt-2 space-y-2">{availableSkills.map((skill) => { const checked = (selectedNode.data.skillIds ?? []).includes(skill.id); return <label key={skill.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px]"><Checkbox checked={checked} onCheckedChange={(value) => { const nextIds = value === true ? [...new Set([...(selectedNode.data.skillIds ?? []), skill.id])] : (selectedNode.data.skillIds ?? []).filter((id) => id !== skill.id); const nextNames = availableSkills.filter((item) => nextIds.includes(item.id)).map((item) => item.name); setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, skillIds: nextIds, skillNames: nextNames } } : node)); setSaveState('unsaved'); }} aria-label={skill.name} /><span>{skill.name}</span></label>; })}</div></div> : null}
        {selectedNode.data.nodeType === 'generic-agent' ? <>
          <Field label={t('editor.genericAgentNode')} htmlFor="agent"><Select value={selectedNode.data.agentId} onValueChange={(value) => { const agent = availableAgents.find((item) => item.id === value); setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, agentId: value, label: agent?.name ?? node.data.label, agentVersion: agent?.latestVersion ? `v${agent.latestVersion}` : agent?.version ?? node.data.agentVersion, agentVersionId: agent?.latestVersionId ?? undefined } } : node)); setSaveState('unsaved'); }}><SelectTrigger id="agent"><SelectValue /></SelectTrigger><SelectContent>{publishedAgents.map((agent) => <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>)}</SelectContent></Select></Field>
          <Field label={t('editor.agentVersion')} htmlFor="agent-version"><Select value={selectedNode.data.agentVersionId} onValueChange={(value) => { const version = selectedAgentVersionsQuery.data?.find((item) => item.id === value); setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, agentVersionId: value, agentVersion: version ? `v${version.version}` : node.data.agentVersion } } : node)); setSaveState('unsaved'); }} disabled={selectedAgentVersionsQuery.isLoading || selectedAgentVersionsQuery.isError || !(selectedAgentVersionsQuery.data?.length)}><SelectTrigger id="agent-version"><SelectValue placeholder={selectedAgentVersionsQuery.isLoading ? t('editor.loadingVersions') : t('editor.selectImmutableVersion')} /></SelectTrigger><SelectContent>{(selectedAgentVersionsQuery.data ?? []).map((version) => <SelectItem key={version.id} value={version.id}>v{version.version} · {version.model}</SelectItem>)}</SelectContent></Select>{!selectedNode.data.agentVersionId ? <p className="mt-1 text-[12px] text-danger">{t('editor.selectVersionBeforePublish')}</p> : null}</Field>
          <Field label={t('editor.errorPolicy')} htmlFor="policy"><Select value={selectedNode.data.errorPolicy} onValueChange={(value) => { setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, errorPolicy: value as 'stop' | 'retry' } } : node)); setSaveState('unsaved'); }}><SelectTrigger id="policy"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="stop">{t('editor.stop')}</SelectItem><SelectItem value="retry">{t('editor.retry')}</SelectItem></SelectContent></Select></Field>
        </> : null}
        <div className="rounded-md border border-border bg-surface-subtle p-3"><p className="text-[12px] font-medium">{t('editor.connections')}</p><div className="mt-2 flex justify-between gap-3 text-[12px] text-muted-foreground"><span>{t('editor.incomingConnections')}</span><span className="tabular-nums">{edges.filter((edge) => edge.target === selectedNode.id).length}</span></div><div className="mt-1 flex justify-between gap-3 text-[12px] text-muted-foreground"><span>{t('editor.outgoingConnections')}</span><span className="tabular-nums">{edges.filter((edge) => edge.source === selectedNode.id).length}</span></div></div>
        <div className="flex gap-2 border-t border-border pt-4"><Button type="button" variant="secondary" size="compact" className="flex-1" onClick={() => duplicateNode(selectedNode.id)}><Copy className="size-4" />{t('editor.duplicate')}</Button><Button type="button" variant="destructive" size="compact" className="flex-1" onClick={() => removeNode(selectedNode.id)}><Trash2 className="size-4" />{t('editor.remove')}</Button></div>
      </div>
    </div>
  ) : selectedEdge ? (
    <div className="flex min-h-0 w-full min-w-0 flex-col"><div className="flex items-start gap-2"><Button type="button" variant="ghost" size="icon-compact" aria-label={t('editor.nodePalette')} onClick={showNodePalette}><ArrowLeft className="size-4" /></Button><div className="min-w-0"><p className="text-xs font-medium text-muted-foreground">{t('editor.connection')}</p><h2 className="mt-1 text-sm font-semibold">{nodeLabel(nodes, selectedEdge.source)} → {nodeLabel(nodes, selectedEdge.target)}</h2></div></div><div className="mt-5 rounded-md border border-border bg-surface-subtle p-3 font-mono text-[12px] text-muted-foreground"><p>{selectedEdge.sourceHandle ?? 'output'}</p><p className="my-1">↓</p><p>{selectedEdge.targetHandle ?? 'input'}</p></div><Button type="button" variant="destructive" size="compact" className="mt-4" onClick={() => removeEdge(selectedEdge.id)}><Trash2 className="size-4" />{t('editor.remove')}</Button></div>
  ) : <div className="flex h-full min-h-32 items-center justify-center text-center text-[13px] text-muted-foreground">{t('editor.selectCanvasItem')}</div>;

  const contextPanel = selectedNode || selectedEdge ? inspector : palette;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceChrome
        back={<Button variant="ghost" size="icon-compact" type="button" aria-label={t('common:actions.back')} onClick={() => void navigate({ to: '/workflows' })}><ArrowLeft className="size-4" /></Button>}
        crumbs={[{ label: t('title'), to: '/workflows' }, { label: isNew ? t('editor.new') : existing?.name ?? t('editor.fallback') }]}
        status={<SaveIndicator state={saveState} />}
        actions={<div className="flex items-center gap-1.5"><Button variant="ghost" size="icon-compact" className="lg:hidden" type="button" aria-label={t('editor.nodePalette')} onClick={() => { showNodePalette(); setContextPanelOpen(true); }}><Plus className="size-4" /></Button><Button variant="ghost" size="icon-compact" className="lg:hidden" type="button" aria-label={t('editor.configureStep')} onClick={() => setContextPanelOpen(true)} disabled={!selectedNode && !selectedEdge}><PanelRight className="size-4" /></Button><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-compact" type="button" aria-label={t('editor.undo')} onClick={() => void moveRevision('undo')} disabled={!canUndo || saveState === 'saving'}><Undo2 className="size-4" /></Button></TooltipTrigger><TooltipContent>{t('editor.undo')}</TooltipContent></Tooltip><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-compact" type="button" aria-label={t('editor.redo')} onClick={() => void moveRevision('redo')} disabled={!canRedo || saveState === 'saving'}><Redo2 className="size-4" /></Button></TooltipTrigger><TooltipContent>{t('editor.redo')}</TooltipContent></Tooltip><Button variant="ghost" size="compact" onClick={() => setSettingsOpen(true)}><SlidersHorizontal className="size-4" />{t('editor.workflowSettings')}</Button><Button asChild variant="ghost" size="compact" className="hidden sm:inline-flex"><Link to="/workflows/$workflowId/versions" params={{ workflowId }}>{t('editor.versions')}</Link></Button><Button variant="secondary" size="compact" className="hidden sm:inline-flex" onClick={save} disabled={saveState === 'saving'}>{t('common:actions.save')}</Button><Button variant="secondary" size="compact" className="hidden sm:inline-flex" onClick={() => void runWorkflow()} disabled={runSubmitting || isNew || saveState !== 'saved' || !existing?.latestVersionId}>{runSubmitting ? t('editor.running') : existing?.latestVersion ? t('editor.runVersion', { version: existing.latestVersion }) : t('editor.run')}</Button><Button size="compact" onClick={() => setPublishOpen(true)}>{t('common:actions.publish')}</Button></div>}
      />
      <div className="flex min-h-0 flex-1">
        <main ref={canvasRef} className="relative min-w-0 flex-1 bg-background" aria-label={t('editor.canvas')}>
          {saveError ? <p className="absolute left-4 top-4 z-10 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[13px] text-danger" role="alert">{saveError}</p> : null}
          <div className="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-[12px] text-muted-foreground"><span>{t('editor.nodeCount', { count: nodes.length })}</span><span aria-hidden="true">·</span><span>{t('editor.edgeCount', { count: edges.length })}</span><Button variant="secondary" size="compact" className="sm:hidden" onClick={save} disabled={saveState === 'saving'}><Check className="size-4" />{t('common:actions.save')}</Button><Button variant="secondary" size="compact" className="sm:hidden" onClick={() => void runWorkflow()} disabled={runSubmitting || isNew || saveState !== 'saved' || !existing?.latestVersionId}>{t('editor.run')}</Button></div>
          {nodes.length === 0 ? <div className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center p-6 text-center"><div><Workflow className="mx-auto size-6 text-muted-foreground" aria-hidden="true" /><p className="mt-3 text-sm font-medium">{t('editor.emptyCanvas')}</p></div></div> : null}
          <ReactFlow<WorkflowCanvasNode, WorkflowCanvasEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={workflowNodeTypes}
            colorMode={resolvedTheme}
            onInit={setFlowInstance}
            onNodesChange={(changes) => { onNodesChange(changes); if (changes.some((change) => change.type === 'position' && change.dragging === false)) setSaveState('unsaved'); }}
            onEdgesChange={(changes) => { onEdgesChange(changes); if (changes.some((change) => change.type === 'remove')) setSaveState('unsaved'); }}
            isValidConnection={(connection) => canConnect(connection, nodes, edges)}
            onConnect={handleConnect}
            onConnectEnd={handleConnectEnd}
            onReconnect={handleReconnect}
            onNodeClick={(_, node) => selectOnlyNode(node.id)}
            onEdgeClick={(_, edge) => selectOnlyEdge(edge.id)}
            onPaneClick={showNodePalette}
            onSelectionChange={({ nodes: selectedNodes, edges: selectedEdges }) => { if (selectedNodes.length + selectedEdges.length > 0 && !window.matchMedia('(min-width: 1024px)').matches) setContextPanelOpen(true); }}
            onNodesDelete={(deleted) => { if (deleted.length > 0) { const deletedIds = new Set(deleted.map((node) => node.id)); setEdges((current) => current.filter((edge) => !deletedIds.has(edge.source) && !deletedIds.has(edge.target))); setSaveState('unsaved'); } }}
            onEdgesDelete={(deleted) => { if (deleted.length > 0) setSaveState('unsaved'); }}
            deleteKeyCode={['Backspace', 'Delete']}
            multiSelectionKeyCode={null}
            selectionKeyCode={null}
            panOnScroll
            panOnScrollMode={PanOnScrollMode.Free}
            zoomOnScroll={false}
            fitView
            fitViewOptions={{ padding: 0.2, duration: 180 }}
            proOptions={{ hideAttribution: true }}
            className="workflow-react-flow"
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </main>
        <aside className="hidden w-[360px] min-w-0 shrink-0 overflow-auto border-l border-border bg-surface p-4 lg:flex">{contextPanel}</aside>
      </div>
      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}><DialogContent><DialogHeader><DialogTitle>{t('editor.chooseTemplate')}</DialogTitle><DialogDescription>{t('editor.chooseTemplateDescription')}</DialogDescription></DialogHeader><div className="grid gap-2 sm:grid-cols-2"><button type="button" className="rounded-lg border border-border bg-surface p-4 text-left transition-colors duration-[120ms] hover:border-brand hover:bg-brand-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45" onClick={() => applyTemplate('blank')}><p className="text-sm font-semibold">{t('editor.blankTemplate')}</p><p className="mt-1 text-[13px] text-muted-foreground">{t('editor.blankTemplateDescription')}</p></button><button type="button" className="rounded-lg border border-border bg-surface p-4 text-left transition-colors duration-[120ms] hover:border-brand hover:bg-brand-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:opacity-50" onClick={() => applyTemplate('daily')} disabled={publishedAgents.length === 0}><p className="text-sm font-semibold">{t('editor.dailyTemplate')}</p><p className="mt-1 text-[13px] text-muted-foreground">{publishedAgents.length === 0 ? t('editor.dailyTemplateUnavailable') : t('editor.dailyTemplateDescription')}</p></button></div></DialogContent></Dialog>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}><DialogContent className="max-h-[85vh] overflow-auto"><DialogHeader><DialogTitle>{t('editor.workflowSettings')}</DialogTitle><DialogDescription>{t('editor.workflowSettingsDescription')}</DialogDescription></DialogHeader><div className="flex flex-col gap-5"><section><h3 className="text-sm font-semibold">{t('editor.general')}</h3><Field className="mt-3" label={t('editor.name')} htmlFor="wf-name"><Input id="wf-name" value={name} onChange={(event) => { setName(event.target.value); setSaveState('unsaved'); }} /></Field></section><section><h3 className="text-sm font-semibold">{t('editor.inputs')}</h3><Field className="mt-3" label={t('editor.input')} htmlFor="wf-input"><Textarea id="wf-input" className="font-mono text-[13px]" value={input} onChange={(event) => { setInput(event.target.value); setSaveState('unsaved'); }} /></Field></section><section><h3 className="text-sm font-semibold">{t('editor.execution')}</h3><Field className="mt-3" label={t('editor.defaultErrorPolicy')} htmlFor="default-policy"><Select value={executionPolicy} onValueChange={(value) => { setExecutionPolicy(value as 'stop' | 'retry'); setSaveState('unsaved'); }}><SelectTrigger id="default-policy"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="stop">{t('editor.stop')}</SelectItem><SelectItem value="retry">{t('editor.retry')}</SelectItem></SelectContent></Select></Field></section><section className="rounded-md border border-border bg-surface-subtle p-3"><h3 className="text-sm font-semibold">{t('editor.versioning')}</h3><p className="mt-1 text-[13px] text-muted-foreground">{t('editor.versioningHint')}</p></section></div><DialogFooter><Button onClick={() => setSettingsOpen(false)}>{t('common:actions.close')}</Button></DialogFooter></DialogContent></Dialog>
      <Sheet open={contextPanelOpen} onOpenChange={setContextPanelOpen}><SheetContent side="right" className="overflow-auto p-4 pt-5"><SheetHeader className="sr-only"><SheetTitle>{selectedNode || selectedEdge ? t('editor.configureStep') : t('editor.nodePalette')}</SheetTitle><SheetDescription>{selectedNode || selectedEdge ? t('editor.selectCanvasItem') : t('editor.paletteHint')}</SheetDescription></SheetHeader>{contextPanel}</SheetContent></Sheet>
      <Dialog open={publishOpen} onOpenChange={setPublishOpen}><DialogContent><DialogHeader><DialogTitle>{t('editor.publishTitle')}</DialogTitle><DialogDescription>{t('editor.publishDescription')}</DialogDescription></DialogHeader><DialogFooter><Button variant="secondary" onClick={() => setPublishOpen(false)}>{t('common:actions.cancel')}</Button><Button onClick={() => void publishWorkflow()}>{t('common:actions.publish')}</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}

function toFlowNodes(definition: WorkflowDefinition, onTextChange: (nodeId: string, value: string) => void): WorkflowCanvasNode[] {
  return definition.nodes.map((node) => {
    const config = asRecord(node.config);
    const nodeType = node.type === 'worklite/input' ? 'input' : node.type === 'worklite/text' ? 'text' : node.type === 'worklite/skill-set' ? 'skill-set' : 'generic-agent';
    const agentId = typeof config.agentId === 'string' ? config.agentId : undefined;
    const label = typeof config.label === 'string' ? config.label : nodeType === 'input' ? 'Workflow Input' : nodeType === 'text' ? 'System Prompt' : nodeType === 'skill-set' ? 'Skill Set' : agentId ?? node.id;
    const agentVersion = typeof config.agentVersion === 'string' ? config.agentVersion : 'draft';
    return {
      id: node.id,
      type: nodeType,
      position: node.position,
      data: {
        nodeType,
        label,
        agentId,
        agentVersion,
        agentVersionId: typeof config.agentVersionId === 'string' ? config.agentVersionId : undefined,
        text: typeof config.text === 'string' ? config.text : '',
        skillIds: Array.isArray(config.skillIds) ? config.skillIds.filter((value): value is string => typeof value === 'string') : [],
        skillNames: Array.isArray(config.skillNames) ? config.skillNames.filter((value): value is string => typeof value === 'string') : [],
        outputType: config.outputType === 'file' ? 'file' : nodeType === 'text' ? 'text' : undefined,
        fileName: typeof config.fileName === 'string' ? config.fileName : undefined,
        fileType: config.fileType === 'json' || config.fileType === 'text' || config.fileType === 'markdown' ? config.fileType : undefined,
        errorPolicy: node.errorPolicy,
        onTextChange,
      },
    };
  });
}

function toFlowEdges(definition: WorkflowDefinition): WorkflowCanvasEdge[] {
  return definition.edges.map((edge) => ({ id: edge.id, source: edge.sourceNodeId, sourceHandle: edge.sourcePort, target: edge.targetNodeId, targetHandle: edge.targetPort, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } }));
}

function canConnect(connection: { source: string | null; sourceHandle?: string | null; target: string | null; targetHandle?: string | null }, nodes: WorkflowCanvasNode[], edges: WorkflowCanvasEdge[]): boolean {
  const { source, sourceHandle, target, targetHandle } = connection;
  if (!source || !target || source === target || !targetHandle) return false;
  const sourceNode = nodes.find((node) => node.id === source);
  const targetNode = nodes.find((node) => node.id === target);
  if (!sourceNode || !targetNode || targetNode.data.nodeType !== 'generic-agent') return false;
  const sourceType = sourceNode.data.nodeType;
  const sourcePort = sourceHandle ?? 'output';
  if (sourcePort !== 'output') return false;
  if (targetHandle === 'systemPrompt' && sourceType !== 'text') return false;
  if (targetHandle === 'skills' && sourceType !== 'skill-set') return false;
  if (targetHandle === 'context' && sourceType === 'skill-set') return false;
  if (!['context', 'systemPrompt', 'skills'].includes(targetHandle)) return false;
  if (edges.some((edge) => edge.source === source && edge.target === target && (edge.sourceHandle ?? 'output') === sourcePort && (edge.targetHandle ?? 'input') === targetHandle)) return false;
  if (edges.some((edge) => edge.target === target && (edge.targetHandle ?? 'input') === targetHandle)) return false;
  return !wouldCreateCycle(source, target, edges);
}

function wouldCreateCycle(source: string, target: string, edges: WorkflowCanvasEdge[]): boolean {
  const pending = [target];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    if (current === source) return true;
    visited.add(current);
    for (const edge of edges) if (edge.source === current) pending.push(edge.target);
  }
  return false;
}

function toDefinitionNode(node: WorkflowCanvasNode): WorkflowNodeDefinition {
  const base = { label: node.data.label };
  let type = 'worklite/generic-agent';
  let config: Record<string, unknown> = base;
  if (node.data.nodeType === 'input') {
    type = 'worklite/input';
  } else if (node.data.nodeType === 'text') {
    type = 'worklite/text';
    config = { ...base, text: node.data.text ?? '' };
  } else if (node.data.nodeType === 'skill-set') {
    type = 'worklite/skill-set';
    config = { ...base, skillIds: node.data.skillIds ?? [], skillNames: node.data.skillNames ?? [] };
  } else {
    config = {
      ...base,
      agentId: node.data.agentId,
      agentVersion: node.data.agentVersion,
      ...(node.data.agentVersionId ? { agentVersionId: node.data.agentVersionId } : {}),
      ...(node.data.outputType === 'file' ? { outputType: 'file', fileName: node.data.fileName ?? 'workflow-output.txt', fileType: node.data.fileType ?? 'markdown' } : {}),
    };
  }
  return {
    id: node.id,
    position: node.position,
    type,
    typeVersion: '1',
    config,
    errorPolicy: node.data.errorPolicy,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nodeLabel(nodes: WorkflowCanvasNode[], nodeId: string): string {
  return nodes.find((node) => node.id === nodeId)?.data.label ?? nodeId;
}

function nodeTypeLabel(nodeType: WorkflowCanvasNode['data']['nodeType'], t: TFunction<'workflows'>): string {
  if (nodeType === 'input') return t('editor.workflowInputNode');
  if (nodeType === 'text') return t('editor.systemPromptNode');
  if (nodeType === 'skill-set') return t('editor.skillSetNode');
  return t('editor.genericAgentNode');
}

function PaletteButton({ icon, title, description, onClick }: { icon: ReactNode; title: string; description: string; onClick: () => void }) {
  return <button type="button" className="flex w-full items-center gap-3 rounded-md border border-transparent px-2 py-2 text-left transition-colors duration-[120ms] hover:border-border hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45" onClick={onClick}>{icon}<span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{title}</span><span className="block truncate text-[12px] text-muted-foreground">{description}</span></span><Plus className="size-4 text-muted-foreground" aria-hidden="true" /></button>;
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
