import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { addEdge, Background, BackgroundVariant, Controls, MarkerType, PanOnScrollMode, ReactFlow, reconnectEdge, useEdgesState, useNodesState, type OnConnect, type OnConnectEnd, type OnReconnect, type ReactFlowInstance } from '@xyflow/react';
import { ArrowLeft, Bot, Braces, Check, Copy, Download, FilePlus2, FileSearch, FileText, Image as ImageIcon, LayoutDashboard, PanelRight, Plus, Redo2, Search, Send, SlidersHorizontal, Timer, Trash2, Undo2, Workflow } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { WorkflowDashboardElement, WorkflowDashboardField, WorkflowDashboardFieldType, WorkflowDashboardLayout, WorkflowDefinition, WorkflowEdgeCondition, WorkflowEdgePredicateOperator, WorkflowEditOperation, WorkflowNodeDefinition } from '@worklite/contracts';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { SaveIndicator } from '@/components/save-indicator';
import { useLocale } from '@/components/locale-provider';
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
import { workflowNodeTypes, type WorkflowCanvasEdge, type WorkflowCanvasEdgeData, type WorkflowCanvasNode } from '@/components/workflow-canvas-nodes';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { api } from '@/api/client';
import { useMcpServersQuery, useModelProvidersQuery, runsQueryKey, useSkillsQuery, useWorkflowQuery, useWorkflowScheduleQuery, workflowScheduleQueryKey, workflowsQueryKey } from '@/api/queries';
import { queryClient } from '@/lib/query-client';
import { formatDateTime } from '@/i18n/format';

export const Route = createFileRoute('/workflows/$workflowId')({
  component: WorkflowEditorPage,
});

const emptyDefinition: WorkflowDefinition = {
  schemaVersion: 4,
  input: {},
  defaults: { errorPolicy: 'stop' },
  nodes: [],
  edges: [],
};

function WorkflowEditorPage() {
  const { t } = useTranslation(['workflows', 'common']);
  const { resolvedTheme } = useTheme();
  const { locale } = useLocale();
  const { workflowId } = Route.useParams();
  const workspaceSlug = 'personal';
  const isNew = workflowId === 'new';
  const { data: existing } = useWorkflowQuery(workspaceSlug, workflowId);
  const scheduleQuery = useWorkflowScheduleQuery(workspaceSlug, workflowId);
  const { data: availableSkills = [] } = useSkillsQuery(workspaceSlug);
  const { data: availableMcpServers = [] } = useMcpServersQuery(workspaceSlug);
  const { data: availableProviders = [] } = useModelProvidersQuery(workspaceSlug);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowCanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<WorkflowCanvasEdge>([]);
  const [name, setName] = useState(existing?.name ?? t('editor.untitled'));
  const [input, setInput] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>(isNew ? 'unsaved' : 'saved');
  const [draftRevisionId, setDraftRevisionId] = useState('');
  const [persistedDefinition, setPersistedDefinition] = useState<WorkflowDefinition>(emptyDefinition);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [contextPanelOpen, setContextPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [executionPolicy, setExecutionPolicy] = useState<'stop' | 'retry'>('stop');
  const [publishOpen, setPublishOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [runSubmitting, setRunSubmitting] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [edgeValueDrafts, setEdgeValueDrafts] = useState<Record<string, string>>({});
  const [edgeValueErrors, setEdgeValueErrors] = useState<Record<string, boolean>>({});
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<WorkflowCanvasNode, WorkflowCanvasEdge> | null>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const navigate = useNavigate();

  const hydrateDefinition = useCallback((definition: WorkflowDefinition, preferredNodeId?: string | null) => {
    const nextNodes = toFlowNodes(definition);
    const nextEdges = toFlowEdges(definition, t);
    const nextSelection = preferredNodeId && nextNodes.some((node) => node.id === preferredNodeId) ? preferredNodeId : null;
    setNodes(nextNodes.map((node) => ({ ...node, selected: node.id === nextSelection })));
    setEdges(nextEdges.map((edge) => ({ ...edge, selected: false })));
    setEdgeValueDrafts({});
    setEdgeValueErrors({});
  }, [setEdges, setNodes, t]);

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
  const modelOptions = useMemo(() => availableProviders.flatMap((provider) => provider.models.map((model) => `${provider.name}/${model}`)), [availableProviders]);
  const filteredTimerVisible = !paletteQuery.trim() || `${t('editor.timerNode')} ${t('editor.timerNodeDescription')}`.toLowerCase().includes(paletteQuery.trim().toLowerCase());
  const filteredAgentVisible = !paletteQuery.trim() || `${t('editor.agentNode')} ${t('editor.agentNodeDescription')}`.toLowerCase().includes(paletteQuery.trim().toLowerCase());
  const filteredDashboardVisible = !paletteQuery.trim() || `${t('editor.dashboardNode')} ${t('editor.dashboardNodeDescription')}`.toLowerCase().includes(paletteQuery.trim().toLowerCase());
  const filteredArtifactVisible = !paletteQuery.trim() || `${t('editor.artifactNode')} ${t('editor.artifactNodeDescription')}`.toLowerCase().includes(paletteQuery.trim().toLowerCase());
  const filteredArtifactQueryVisible = !paletteQuery.trim() || `${t('editor.artifactQueryNode')} ${t('editor.artifactQueryNodeDescription')}`.toLowerCase().includes(paletteQuery.trim().toLowerCase());
  const filteredImageVisible = !paletteQuery.trim() || `${t('editor.imageNode')} ${t('editor.imageNodeDescription')}`.toLowerCase().includes(paletteQuery.trim().toLowerCase());
  const filteredWechatVisible = !paletteQuery.trim() || `${t('editor.wechatNode')} ${t('editor.wechatNodeDescription')}`.toLowerCase().includes(paletteQuery.trim().toLowerCase());

  function currentDefinition(): WorkflowDefinition {
    return {
      schemaVersion: 4,
      input: input ? { example: input } : {},
      defaults: { errorPolicy: executionPolicy },
      nodes: nodes.map(toDefinitionNode),
      edges: edges.map((edge) => ({
        id: edge.id,
        sourceNodeId: edge.source,
        sourcePort: edge.sourceHandle ?? 'output',
        targetNodeId: edge.target,
        targetPort: edge.targetHandle ?? 'input',
        ...(edge.data?.condition ? { condition: edge.data.condition } : {}),
        ...(edge.data?.maxTraversals !== undefined ? { maxTraversals: edge.data.maxTraversals } : {}),
      })),
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
    const data: WorkflowCanvasEdgeData = wouldCreateCycle(connection.source!, connection.target!, edges) ? { maxTraversals: 1 } : {};
    const edge = applyEdgePresentation({ ...connection, id: createId('edge'), type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed }, selected: false, data } as WorkflowCanvasEdge, t);
    setEdges((current) => addEdge(edge, current.map((item) => ({ ...item, selected: false }))));
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
    const bounded = wouldCreateCycle(connection.source!, connection.target!, nextEdges.filter((edge) => edge.id !== oldEdge.id));
    setEdges(nextEdges.map((edge) => applyEdgePresentation({
      ...edge,
      type: edge.type ?? 'smoothstep',
      markerEnd: edge.markerEnd ?? { type: MarkerType.ArrowClosed },
      selected: false,
      data: edge.id === oldEdge.id && bounded && edge.data?.maxTraversals === undefined ? { ...edge.data, maxTraversals: 1 } : edge.data,
    }, t)));
    setSaveState('unsaved');
  }, [edges, nodes, setEdges, t]);

  function addInputNode() {
    const id = createId('input');
    const node: WorkflowCanvasNode = {
      id,
      type: 'input',
      position: nextPosition(),
      selected: true,
      data: { nodeType: 'input', label: t('editor.workflowInputNode'), errorPolicy: executionPolicy },
    };
    addNode(node);
  }

  function addTimerNode() {
    if (nodes.some((node) => node.data.nodeType === 'timer')) {
      toast.error(t('editor.timerLimit'));
      return;
    }
    const id = createId('timer');
    const node: WorkflowCanvasNode = {
      id,
      type: 'timer',
      position: nextPosition(),
      selected: true,
      data: { nodeType: 'timer', label: t('editor.timerNode'), timerEnabled: true, timerIntervalSeconds: 300, errorPolicy: executionPolicy },
    };
    addNode(node);
  }

  function addDashboardNode() {
    if (nodes.some((node) => node.data.nodeType === 'dashboard')) {
      toast.error(t('editor.dashboardLimit'));
      return;
    }
    const id = createId('dashboard');
    const node: WorkflowCanvasNode = {
      id,
      type: 'dashboard',
      position: nextPosition(),
      selected: true,
      data: { nodeType: 'dashboard', label: t('editor.dashboardNode'), dashboardLayout: { header: [], main: [{ kind: 'list', titleKey: 'title', fields: [{ key: 'title', label: t('editor.fieldTitle'), type: 'text' }] }], footer: [] }, errorPolicy: executionPolicy },
    };
    addNode(node);
  }

  function addAgentNode() {
    const id = createId('agent');
    const node: WorkflowCanvasNode = {
      id,
      type: 'agent',
      position: nextPosition(),
      selected: true,
      data: { nodeType: 'agent', label: t('editor.agentNode'), model: modelOptions[0] ?? '', systemPrompt: '', outputFormat: 'text', skillIds: [], skillNames: [], mcpServerIds: [], mcpServerNames: [], errorPolicy: executionPolicy },
    };
    addNode(node);
  }

  function addArtifactNode() {
    const id = createId('artifact');
    const node: WorkflowCanvasNode = {
      id,
      type: 'artifact',
      position: nextPosition(),
      selected: true,
      data: { nodeType: 'artifact', label: t('editor.artifactNode'), artifactName: '', artifactType: 'text', errorPolicy: executionPolicy },
    };
    addNode(node);
  }

  function addArtifactQueryNode() {
    const id = createId('artifact-query');
    addNode({ id, type: 'artifactQuery', position: nextPosition(), selected: true, data: { nodeType: 'artifactQuery', label: t('editor.artifactQueryNode'), queryName: '', queryTitleField: 'title', queryDescriptionFields: ['description'], errorPolicy: executionPolicy } });
  }

  function addImageNode() {
    const id = createId('image');
    const node: WorkflowCanvasNode = {
      id,
      type: 'image',
      position: nextPosition(),
      selected: true,
      data: { nodeType: 'image', label: t('editor.imageNode'), imageCount: 1, imageBackground: 'opaque', imageQuality: 'medium', imageSize: '1024x1024', errorPolicy: executionPolicy },
    };
    addNode(node);
  }

  function addWechatPublishNode() {
    const id = createId('wechat');
    const node: WorkflowCanvasNode = {
      id,
      type: 'wechatPublish',
      position: nextPosition(),
      selected: true,
      data: { nodeType: 'wechatPublish', label: t('editor.wechatNode'), wechatAccountId: 'wechat_official_account_personal', wechatMode: 'draft', wechatNodeVersion: '2', errorPolicy: executionPolicy },
    };
    addNode(node);
  }

  function addNode(node: WorkflowCanvasNode) {
    setNodes((current) => [...current.map((item) => ({ ...item, selected: false })), node]);
    setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
    setSaveState('unsaved');
  }

  function removeNode(nodeId: string) {
    for (const edge of edges) {
      if (edge.source === nodeId || edge.target === nodeId) clearEdgeValueState(edge.id);
    }
    setNodes((current) => current.filter((node) => node.id !== nodeId));
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
    setSaveState('unsaved');
  }

  function duplicateNode(nodeId: string) {
    const source = nodes.find((node) => node.id === nodeId);
    if (!source) return;
    if (source.data.nodeType === 'timer' && nodes.some((node) => node.id !== source.id && node.data.nodeType === 'timer')) {
      toast.error(t('editor.timerLimit'));
      return;
    }
    if (source.data.nodeType === 'dashboard' && nodes.some((node) => node.id !== source.id && node.data.nodeType === 'dashboard')) {
      toast.error(t('editor.dashboardLimit'));
      return;
    }
    const id = createId(source.data.nodeType);
    const duplicate: WorkflowCanvasNode = { ...source, id, position: { x: source.position.x + 40, y: source.position.y + 40 }, selected: true, data: { ...source.data } };
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), duplicate]);
    setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
    setSaveState('unsaved');
  }

  function updateDashboardNode(nodeId: string, update: (data: WorkflowCanvasNode['data']) => WorkflowCanvasNode['data']) {
    setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, data: update(node.data) } : node));
    setSaveState('unsaved');
  }

  function updateDashboardRegion(nodeId: string, region: DashboardLayoutRegion, elements: WorkflowDashboardElement[]) {
    updateDashboardNode(nodeId, (data) => ({ ...data, dashboardLayout: { header: [], main: [], footer: [], ...data.dashboardLayout, [region]: elements } }));
  }

  function updateDashboardElement(nodeId: string, region: DashboardLayoutRegion, index: number, element: WorkflowDashboardElement) {
    const elements = [...(nodes.find((node) => node.id === nodeId)?.data.dashboardLayout?.[region] ?? [])];
    elements[index] = element;
    updateDashboardRegion(nodeId, region, elements);
  }

  function removeDashboardElement(nodeId: string, region: DashboardLayoutRegion, index: number) {
    const elements = (nodes.find((node) => node.id === nodeId)?.data.dashboardLayout?.[region] ?? []).filter((_, itemIndex) => itemIndex !== index);
    updateDashboardRegion(nodeId, region, elements);
  }

  function addDashboardElement(nodeId: string, region: DashboardLayoutRegion, kind: WorkflowDashboardElement['kind']) {
    const blank: WorkflowDashboardElement = kind === 'text'
      ? { kind: 'text', text: '' }
      : kind === 'count'
        ? { kind: 'count', label: t('editor.newElementLabel') }
        : kind === 'metric'
          ? { kind: 'metric', label: t('editor.newElementLabel'), field: 'value', type: 'text' }
          : { kind: 'list', titleKey: 'title', fields: [{ key: 'title', label: t('editor.fieldTitle'), type: 'text' }] };
    updateDashboardRegion(nodeId, region, [...(nodes.find((node) => node.id === nodeId)?.data.dashboardLayout?.[region] ?? []), blank]);
  }

  function clearEdgeValueState(edgeId: string) {
    setEdgeValueDrafts((current) => {
      if (!(edgeId in current)) return current;
      const next = { ...current };
      delete next[edgeId];
      return next;
    });
    setEdgeValueErrors((current) => {
      if (!(edgeId in current)) return current;
      const next = { ...current };
      delete next[edgeId];
      return next;
    });
  }

  function removeEdge(edgeId: string) {
    setEdges((current) => current.filter((edge) => edge.id !== edgeId));
    clearEdgeValueState(edgeId);
    setSaveState('unsaved');
  }

  function updateEdgeData(edgeId: string, data: WorkflowCanvasEdgeData) {
    setEdges((current) => current.map((edge) => edge.id === edgeId ? applyEdgePresentation({ ...edge, data }, t) : edge));
    setSaveState('unsaved');
  }

  function updateEdgeMode(edge: WorkflowCanvasEdge, mode: 'always' | 'condition' | 'fallback') {
    const condition: WorkflowEdgeCondition | undefined = mode === 'always'
      ? undefined
      : mode === 'fallback'
        ? { kind: 'fallback' }
        : edge.data?.condition?.kind === 'predicate'
          ? edge.data.condition
          : { kind: 'predicate', path: '$', operator: 'truthy' };
    clearEdgeValueState(edge.id);
    updateEdgeData(edge.id, { ...edge.data, condition });
  }

  function updateEdgePredicate(edge: WorkflowCanvasEdge, patch: { path?: string; operator?: WorkflowEdgePredicateOperator; value?: unknown }, omitValue = false) {
    const current = edge.data?.condition?.kind === 'predicate' ? edge.data.condition : { kind: 'predicate' as const, path: '$', operator: 'truthy' as const };
    const base = { kind: 'predicate' as const, path: patch.path ?? current.path, operator: patch.operator ?? current.operator };
    const condition: Extract<WorkflowEdgeCondition, { kind: 'predicate' }> = omitValue
      ? base
      : { ...base, ...('value' in patch ? { value: patch.value } : 'value' in current ? { value: current.value } : {}) };
    updateEdgeData(edge.id, { ...edge.data, condition });
  }

  async function save() {
    if (saveState === 'saving') return;
    if (Object.values(edgeValueErrors).some(Boolean)) {
      setSaveError(t('editor.edgeComparisonInvalid'));
      return;
    }
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

  async function exportWorkflow() {
    if (isNew || !existing) {
      toast.message(t('editor.saveBeforeExport'));
      return;
    }
    try {
      const document = await api.exportWorkflow(workspaceSlug, workflowId);
      const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = `${existing.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workflow'}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success(t('editor.exported'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('editor.exportFailed'));
    }
  }

  async function deleteWorkflow() {
    if (isNew) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await api.deleteWorkflow(workspaceSlug, workflowId);
      setDeleteOpen(false);
      setDeleteError('');
      toast.success(t('delete.success'));
      await queryClient.invalidateQueries({ queryKey: workflowsQueryKey() });
      void navigate({ to: '/workflows' });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t('delete.failed'));
      setDeleteBusy(false);
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
      await queryClient.invalidateQueries({ queryKey: workflowScheduleQueryKey(workflowId) });
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
      await api.createRun(existing.latestVersionId, { input });
      await queryClient.invalidateQueries({ queryKey: runsQueryKey() });
      toast.success(t('editor.runStarted'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('editor.runFailed'));
    } finally {
      setRunSubmitting(false);
    }
  }

  const palette = (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
      <div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">{t('editor.nodePalette')}</h2><p className="mt-1 text-[12px] text-muted-foreground">{t('editor.paletteHint')}</p></div><FilePlus2 className="size-4 text-muted-foreground" aria-hidden="true" /></div>
      <label className="relative mt-4 block"><span className="sr-only">{t('editor.searchNodes')}</span><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" /><Input className="pl-8" value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} placeholder={t('editor.searchNodes')} /></label>
      <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-auto">
        <PaletteButton icon={<Braces className="size-5 text-info" />} title={t('editor.workflowInputNode')} description={t('editor.runPayload')} onClick={addInputNode} />
        {filteredTimerVisible ? <PaletteButton icon={<Timer className="size-5 text-foreground" />} title={t('editor.timerNode')} description={t('editor.timerNodeDescription')} onClick={addTimerNode} /> : null}
        {filteredAgentVisible ? <PaletteButton icon={<Bot className="size-5 text-info" />} title={t('editor.agentNode')} description={t('editor.agentNodeDescription')} onClick={addAgentNode} /> : null}
        {filteredDashboardVisible ? <PaletteButton icon={<LayoutDashboard className="size-5 text-foreground" />} title={t('editor.dashboardNode')} description={t('editor.dashboardNodeDescription')} onClick={addDashboardNode} /> : null}
        {filteredArtifactVisible ? <PaletteButton icon={<FileText className="size-5 text-foreground" />} title={t('editor.artifactNode')} description={t('editor.artifactNodeDescription')} onClick={addArtifactNode} /> : null}
        {filteredArtifactQueryVisible ? <PaletteButton icon={<FileSearch className="size-5 text-foreground" />} title={t('editor.artifactQueryNode')} description={t('editor.artifactQueryNodeDescription')} onClick={addArtifactQueryNode} /> : null}
        {filteredImageVisible ? <PaletteButton icon={<ImageIcon className="size-5 text-foreground" />} title={t('editor.imageNode')} description={t('editor.imageNodeDescription')} onClick={addImageNode} /> : null}
        {filteredWechatVisible ? <PaletteButton icon={<Send className="size-5 text-foreground" />} title={t('editor.wechatNode')} description={t('editor.wechatNodeDescription')} onClick={addWechatPublishNode} /> : null}
      </div>
    </div>
  );

  const inspector = selectedNode ? (
    <div className="flex min-h-0 w-full min-w-0 flex-col">
      <div className="flex items-start gap-2"><Button type="button" variant="ghost" size="icon-compact" aria-label={t('editor.nodePalette')} onClick={showNodePalette}><ArrowLeft className="size-4" /></Button><div className="min-w-0 flex-1"><p className="text-xs font-medium text-muted-foreground">{nodeTypeLabel(selectedNode.data.nodeType, t)}</p><h2 className="mt-1 truncate text-sm font-semibold">{selectedNode.data.label}</h2></div><PanelRight className="mt-2 size-4 text-muted-foreground" aria-hidden="true" /></div>
      <div className="mt-5 flex flex-col gap-4">
        <Field label={t('editor.nodeName')} htmlFor="node-name"><Input id="node-name" value={selectedNode.data.label} onChange={(event) => { const label = event.target.value; setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, label } } : node)); setSaveState('unsaved'); }} /></Field>
        {selectedNode.data.nodeType === 'timer' ? <>
          <label className="flex items-center gap-2 text-[13px]"><Checkbox checked={selectedNode.data.timerEnabled !== false} onCheckedChange={(checked) => { setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, timerEnabled: checked === true } } : node)); setSaveState('unsaved'); }} aria-label={t('editor.timerEnabled')} /><span>{t('editor.timerEnabled')}</span></label>
          <Field label={t('editor.timerInterval')} htmlFor="timer-interval"><div className="flex items-center gap-2"><Input id="timer-interval" type="number" min={5} step={1} value={String(Math.round((selectedNode.data.timerIntervalSeconds ?? 300) / 60))} onChange={(event) => { const intervalSeconds = Math.round(Number(event.target.value) * 60); setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, timerIntervalSeconds: intervalSeconds } } : node)); setSaveState('unsaved'); }} /><span className="text-[13px] text-muted-foreground">{t('editor.timerMinutes')}</span></div></Field>
          <p className="text-[12px] text-muted-foreground">{t('editor.timerActivatesOnPublish')}</p>
          {scheduleQuery.isLoading ? <p className="text-xs text-muted-foreground">{t('editor.scheduleLoading')}</p> : scheduleQuery.isError ? <p className="text-xs text-destructive">{t('editor.scheduleUnavailable')}</p> : scheduleQuery.data ? <dl className="grid gap-2 rounded-md border border-border bg-surface-subtle p-3 text-xs"><div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t('editor.scheduleVersion')}</dt><dd className="font-medium">v{scheduleQuery.data.workflowVersion}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t('editor.scheduleNextRun')}</dt><dd className="font-medium">{scheduleQuery.data.enabled ? formatDateTime(scheduleQuery.data.nextRunAt, locale) : '—'}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t('editor.scheduleLastStatus')}</dt><dd className="font-medium">{scheduleQuery.data.running ? t('editor.scheduleRunning') : scheduleQuery.data.lastStatus ?? t('editor.scheduleNeverRun')}</dd></div></dl> : <p className="text-xs text-muted-foreground">{t('editor.timerNoActiveSchedule')}</p>}
        </> : null}
        {selectedNode.data.nodeType === 'dashboard' ? <>
          {(['header', 'main', 'footer'] as const).map((region) => {
            const elements = selectedNode.data.dashboardLayout?.[region] ?? [];
            return (
              <div key={region}>
                <div className="flex min-h-8 items-center justify-between gap-2">
                  <p className="text-[12px] font-medium">{t(`editor.dashboardRegion.${region}`)}</p>
                  <Select value="" onValueChange={(value) => addDashboardElement(selectedNode.id, region, value as WorkflowDashboardElement['kind'])}>
                    <SelectTrigger className="h-7 w-[136px]" aria-label={t('editor.dashboardAddElement')}><SelectValue placeholder={t('editor.dashboardAddElement')} /></SelectTrigger>
                    <SelectContent>
                      {(['text', 'count', 'metric', 'list'] as const).map((kind) => <SelectItem key={kind} value={kind}>{t(`editor.elementKinds.${kind}`)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="mt-2 space-y-3">
                  {elements.map((element, index) => (
                    <DashboardElementEditor
                      key={index}
                      idPrefix={`dashboard-${region}-${index}`}
                      element={element}
                      t={t}
                      onChange={(next) => updateDashboardElement(selectedNode.id, region, index, next)}
                      onRemove={() => removeDashboardElement(selectedNode.id, region, index)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          <p className="text-[12px] text-muted-foreground">{t('editor.dashboardActivation')}</p>
        </> : null}
        {selectedNode.data.nodeType === 'artifact' ? <>
          <Field label={t('editor.artifactName')} htmlFor="artifact-name"><Input id="artifact-name" value={selectedNode.data.artifactName ?? ''} onChange={(event) => { const artifactName = event.target.value; setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, artifactName } } : node)); setSaveState('unsaved'); }} /></Field>
          <Field label={t('editor.artifactType')} htmlFor="artifact-type"><Select value={selectedNode.data.artifactType ?? 'text'} onValueChange={(value) => { const artifactType = value as 'text' | 'markdown' | 'json'; setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, artifactType } } : node)); setSaveState('unsaved'); }}><SelectTrigger id="artifact-type"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="text">{t('editor.artifactTypes.text')}</SelectItem><SelectItem value="markdown">{t('editor.artifactTypes.markdown')}</SelectItem><SelectItem value="json">{t('editor.artifactTypes.json')}</SelectItem></SelectContent></Select></Field>
          <p className="text-[12px] text-muted-foreground">{t('editor.artifactCreationDescription')}</p>
        </> : null}
        {selectedNode.data.nodeType === 'artifactQuery' ? <>
          <Field label={t('editor.queryName')} htmlFor="query-name"><Input id="query-name" value={selectedNode.data.queryName ?? ''} onChange={(event) => { const queryName = event.target.value; setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, queryName } } : node)); setSaveState('unsaved'); }} /></Field>
          <Field label={t('editor.queryTitleField')} htmlFor="query-title-field"><Input id="query-title-field" value={selectedNode.data.queryTitleField ?? ''} onChange={(event) => { const queryTitleField = event.target.value; setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, queryTitleField } } : node)); setSaveState('unsaved'); }} /></Field>
          <Field label={t('editor.queryDescriptionFields')} htmlFor="query-description-fields"><Input id="query-description-fields" value={(selectedNode.data.queryDescriptionFields ?? []).join(', ')} onChange={(event) => { const queryDescriptionFields = event.target.value.split(',').map((field) => field.trim()).filter(Boolean); setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, queryDescriptionFields } } : node)); setSaveState('unsaved'); }} /></Field>
          <p className="text-[12px] text-muted-foreground">{t('editor.queryDescription')}</p>
        </> : null}
        {selectedNode.data.nodeType === 'image' ? <>
          <Field label={t('editor.imageModel')} htmlFor="image-model"><Input id="image-model" value="codex/gpt-image-2" readOnly /></Field>
          <Field label={t('editor.imageCount')} htmlFor="image-count"><Input id="image-count" type="number" min={1} step={1} value={String(selectedNode.data.imageCount ?? 1)} onChange={(event) => { const imageCount = Number(event.target.value); setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, imageCount: Number.isFinite(imageCount) ? imageCount : 1 } } : node)); setSaveState('unsaved'); }} /></Field>
          <Field label={t('editor.imageBackground')} htmlFor="image-background"><Select value={selectedNode.data.imageBackground ?? 'opaque'} onValueChange={(value) => { const imageBackground = value as 'opaque' | 'transparent'; setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, imageBackground } } : node)); setSaveState('unsaved'); }}><SelectTrigger id="image-background"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="opaque">{t('editor.imageBackgrounds.opaque')}</SelectItem><SelectItem value="transparent">{t('editor.imageBackgrounds.transparent')}</SelectItem></SelectContent></Select></Field>
          <Field label={t('editor.imageQuality')} htmlFor="image-quality"><Select value={selectedNode.data.imageQuality ?? 'medium'} onValueChange={(value) => { const imageQuality = value as 'low' | 'medium' | 'high'; setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, imageQuality } } : node)); setSaveState('unsaved'); }}><SelectTrigger id="image-quality"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="low">{t('editor.imageQualities.low')}</SelectItem><SelectItem value="medium">{t('editor.imageQualities.medium')}</SelectItem><SelectItem value="high">{t('editor.imageQualities.high')}</SelectItem></SelectContent></Select></Field>
          <Field label={t('editor.imageSize')} htmlFor="image-size"><Select value={selectedNode.data.imageSize ?? '1024x1024'} onValueChange={(value) => { const imageSize = value as '1024x1024' | '1536x1024' | '1024x1536'; setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, imageSize } } : node)); setSaveState('unsaved'); }}><SelectTrigger id="image-size"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="1024x1024">1024×1024</SelectItem><SelectItem value="1536x1024">1536×1024</SelectItem><SelectItem value="1024x1536">1024×1536</SelectItem></SelectContent></Select></Field>
          <p className="text-[12px] text-muted-foreground">{t('editor.imageConnectionHint')}</p>
        </> : null}
        {selectedNode.data.nodeType === 'wechatPublish' ? <>
          <Field label={t('editor.wechatAccount')} htmlFor="wechat-account"><Select value={selectedNode.data.wechatAccountId ?? 'wechat_official_account_personal'} onValueChange={(wechatAccountId) => { setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, wechatAccountId } } : node)); setSaveState('unsaved'); }}><SelectTrigger id="wechat-account"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="wechat_official_account_personal">{t('editor.wechatPersonalAccount')}</SelectItem></SelectContent></Select></Field>
          <Field label={t('editor.wechatMode')} htmlFor="wechat-mode"><Select value={selectedNode.data.wechatMode ?? 'draft'} onValueChange={(value) => { const wechatMode = value as 'draft' | 'publish'; setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, wechatMode } } : node)); setSaveState('unsaved'); }}><SelectTrigger id="wechat-mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="draft">{t('editor.wechatModes.draft')}</SelectItem><SelectItem value="publish">{t('editor.wechatModes.publish')}</SelectItem></SelectContent></Select></Field>
          <p className="text-[12px] text-muted-foreground">{selectedNode.data.wechatMode === 'publish' ? t('editor.wechatPublishPendingHint') : t('editor.wechatDraftHint')}</p>
          {selectedNode.data.wechatNodeVersion !== '1' ? <p className="text-[12px] text-muted-foreground">{t('editor.wechatCoverHint')}</p> : null}
        </> : null}
        {selectedNode.data.nodeType === 'agent' ? <>
          <Field label={t('editor.model')} htmlFor="agent-model"><Select value={selectedNode.data.model} onValueChange={(value) => { setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, model: value } } : node)); setSaveState('unsaved'); }}><SelectTrigger id="agent-model"><SelectValue placeholder={t('editor.selectModel')} /></SelectTrigger><SelectContent>{modelOptions.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent></Select></Field>
          <Field label={t('editor.systemPrompt')} htmlFor="agent-system-prompt"><Textarea id="agent-system-prompt" value={selectedNode.data.systemPrompt ?? ''} onChange={(event) => { const systemPrompt = event.target.value; setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, systemPrompt } } : node)); setSaveState('unsaved'); }} /></Field>
          <Field label={t('editor.outputFormat')} htmlFor="agent-output-format" hint={t('editor.outputFormatDescription')}><Select value={selectedNode.data.outputFormat ?? 'text'} onValueChange={(value) => { const outputFormat = value as 'text' | 'json'; setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, outputFormat } } : node)); setSaveState('unsaved'); }}><SelectTrigger id="agent-output-format"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="text">{t('editor.outputFormats.text')}</SelectItem><SelectItem value="json">{t('editor.outputFormats.json')}</SelectItem></SelectContent></Select></Field>
          <div><p className="text-[12px] font-medium">{t('editor.skills')}</p><div className="mt-2 space-y-2">{availableSkills.map((skill) => { const checked = (selectedNode.data.skillIds ?? []).includes(skill.id); return <label key={skill.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px]"><Checkbox checked={checked} onCheckedChange={(value) => { const nextIds = value === true ? [...new Set([...(selectedNode.data.skillIds ?? []), skill.id])] : (selectedNode.data.skillIds ?? []).filter((id) => id !== skill.id); setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, skillIds: nextIds, skillNames: availableSkills.filter((item) => nextIds.includes(item.id)).map((item) => item.name) } } : node)); setSaveState('unsaved'); }} aria-label={skill.name} /><span>{skill.name}</span></label>; })}</div></div>
          <div><p className="text-[12px] font-medium">{t('editor.mcpServers')}</p><div className="mt-2 space-y-2">{availableMcpServers.map((server) => { const checked = (selectedNode.data.mcpServerIds ?? []).includes(server.id); return <label key={server.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px]"><Checkbox checked={checked} onCheckedChange={(value) => { const nextIds = value === true ? [...new Set([...(selectedNode.data.mcpServerIds ?? []), server.id])] : (selectedNode.data.mcpServerIds ?? []).filter((id) => id !== server.id); setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, mcpServerIds: nextIds, mcpServerNames: availableMcpServers.filter((item) => nextIds.includes(item.id)).map((item) => item.name) } } : node)); setSaveState('unsaved'); }} aria-label={server.name} /><span>{server.name}</span></label>; })}</div></div>
          <Field label={t('editor.errorPolicy')} htmlFor="policy"><Select value={selectedNode.data.errorPolicy} onValueChange={(value) => { setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, errorPolicy: value as 'stop' | 'retry' } } : node)); setSaveState('unsaved'); }}><SelectTrigger id="policy"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="stop">{t('editor.stop')}</SelectItem><SelectItem value="retry">{t('editor.retry')}</SelectItem></SelectContent></Select></Field>
        </> : null}
        <div className="rounded-md border border-border bg-surface-subtle p-3"><p className="text-[12px] font-medium">{t('editor.connections')}</p><div className="mt-2 flex justify-between gap-3 text-[12px] text-muted-foreground"><span>{t('editor.incomingConnections')}</span><span className="tabular-nums">{edges.filter((edge) => edge.target === selectedNode.id).length}</span></div><div className="mt-1 flex justify-between gap-3 text-[12px] text-muted-foreground"><span>{t('editor.outgoingConnections')}</span><span className="tabular-nums">{edges.filter((edge) => edge.source === selectedNode.id).length}</span></div></div>
        <div className="flex gap-2 border-t border-border pt-4"><Button type="button" variant="secondary" size="compact" className="flex-1" onClick={() => duplicateNode(selectedNode.id)}><Copy className="size-4" />{t('editor.duplicate')}</Button><Button type="button" variant="secondary" size="compact" className="flex-1" onClick={() => removeNode(selectedNode.id)}><Trash2 className="size-4" />{t('editor.remove')}</Button></div>
      </div>
    </div>
  ) : selectedEdge ? (
    <div className="flex min-h-0 w-full min-w-0 flex-col">
      <div className="flex items-start gap-2"><Button type="button" variant="ghost" size="icon-compact" aria-label={t('editor.nodePalette')} onClick={showNodePalette}><ArrowLeft className="size-4" /></Button><div className="min-w-0"><p className="text-xs font-medium text-muted-foreground">{t('editor.connection')}</p><h2 className="mt-1 text-sm font-semibold">{nodeLabel(nodes, selectedEdge.source)} → {nodeLabel(nodes, selectedEdge.target)}</h2></div></div>
      <div className="mt-5 rounded-md border border-border bg-surface-subtle p-3 font-mono text-[12px] text-muted-foreground"><p>{selectedEdge.sourceHandle ?? 'output'}</p><p className="my-1">↓</p><p>{selectedEdge.targetHandle ?? 'input'}</p></div>
      <div className="mt-4 space-y-4">
        <Field label={t('editor.edgeMode')} htmlFor="edge-mode">
          <Select value={selectedEdge.data?.condition?.kind === 'predicate' ? 'condition' : selectedEdge.data?.condition?.kind ?? 'always'} onValueChange={(value) => updateEdgeMode(selectedEdge, value as 'always' | 'condition' | 'fallback')}>
            <SelectTrigger id="edge-mode"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="always">{t('editor.edgeModes.always')}</SelectItem><SelectItem value="condition">{t('editor.edgeModes.condition')}</SelectItem><SelectItem value="fallback">{t('editor.edgeModes.fallback')}</SelectItem></SelectContent>
          </Select>
        </Field>
        {selectedEdge.data?.condition?.kind === 'predicate' ? <>
          <Field label={t('editor.edgeOutputPath')} htmlFor="edge-output-path"><Input id="edge-output-path" value={selectedEdge.data.condition.path} onChange={(event) => updateEdgePredicate(selectedEdge, { path: event.target.value })} placeholder="$.status" /></Field>
          <Field label={t('editor.edgeOperator')} htmlFor="edge-operator">
            <Select value={selectedEdge.data.condition.operator} onValueChange={(value) => { const operator = value as WorkflowEdgePredicateOperator; const condition = selectedEdge.data?.condition; clearEdgeValueState(selectedEdge.id); updateEdgePredicate(selectedEdge, edgeOperatorRequiresValue(operator) ? { operator, value: condition?.kind === 'predicate' && 'value' in condition ? condition.value : null } : { operator }, !edgeOperatorRequiresValue(operator)); }}>
              <SelectTrigger id="edge-operator"><SelectValue /></SelectTrigger>
              <SelectContent>{(['equals', 'notEquals', 'truthy', 'falsy', 'exists', 'notExists', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual'] as WorkflowEdgePredicateOperator[]).map((operator) => <SelectItem key={operator} value={operator}>{t(`editor.edgeOperators.${operator}`)}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {edgeOperatorRequiresValue(selectedEdge.data.condition.operator) ? <Field label={t('editor.edgeComparisonValue')} htmlFor="edge-comparison-value">
            <Textarea id="edge-comparison-value" className="min-h-20 font-mono text-[12px]" aria-invalid={edgeValueErrors[selectedEdge.id] || undefined} value={edgeValueDrafts[selectedEdge.id] ?? JSON.stringify(selectedEdge.data.condition.value ?? null, null, 2)} onChange={(event) => { const draft = event.target.value; setSaveState('unsaved'); setEdgeValueDrafts((current) => ({ ...current, [selectedEdge.id]: draft })); try { const value = JSON.parse(draft); setEdgeValueErrors((current) => ({ ...current, [selectedEdge.id]: false })); updateEdgePredicate(selectedEdge, { value }); } catch { setEdgeValueErrors((current) => ({ ...current, [selectedEdge.id]: true })); } }} />
            {edgeValueErrors[selectedEdge.id] ? <p className="mt-1 text-[12px] text-danger">{t('editor.edgeComparisonInvalid')}</p> : null}
          </Field> : null}
        </> : null}
        {selectedEdge.data?.condition?.kind === 'fallback' ? <p className="text-[12px] text-muted-foreground">{t('editor.edgeFallbackHint')}</p> : null}
        <Field label={t('editor.edgeMaxTraversals')} htmlFor="edge-max-traversals">
          <Input id="edge-max-traversals" type="number" min={1} step={1} value={selectedEdge.data?.maxTraversals ?? ''} onChange={(event) => { const value = event.target.value; if (!value) { updateEdgeData(selectedEdge.id, { ...selectedEdge.data, maxTraversals: undefined }); return; } const parsed = Number(value); if (Number.isFinite(parsed)) updateEdgeData(selectedEdge.id, { ...selectedEdge.data, maxTraversals: Math.max(1, Math.floor(parsed)) }); }} />
          <p className="mt-1 text-[12px] text-muted-foreground">{t('editor.edgeMaxTraversalsHint')}</p>
        </Field>
      </div>
      <Button type="button" variant="secondary" size="compact" className="mt-4" onClick={() => removeEdge(selectedEdge.id)}><Trash2 className="size-4" />{t('editor.remove')}</Button>
    </div>
  ) : <div className="flex h-full min-h-32 items-center justify-center text-center text-[13px] text-muted-foreground">{t('editor.selectCanvasItem')}</div>;

  const contextPanel = selectedNode || selectedEdge ? inspector : palette;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceChrome
        back={<Button variant="ghost" size="icon-compact" type="button" aria-label={t('common:actions.back')} onClick={() => void navigate({ to: '/workflows' })}><ArrowLeft className="size-4" /></Button>}
        crumbs={[{ label: t('title'), to: '/workflows' }, { label: isNew ? t('editor.new') : existing?.name ?? t('editor.fallback') }]}
        status={<SaveIndicator state={saveState} />}
        actions={<div className="flex items-center gap-1.5"><Button variant="ghost" size="icon-compact" className="lg:hidden" type="button" aria-label={t('editor.nodePalette')} onClick={() => { showNodePalette(); setContextPanelOpen(true); }}><Plus className="size-4" /></Button><Button variant="ghost" size="icon-compact" className="lg:hidden" type="button" aria-label={t('editor.configureStep')} onClick={() => setContextPanelOpen(true)} disabled={!selectedNode && !selectedEdge}><PanelRight className="size-4" /></Button><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-compact" type="button" aria-label={t('editor.undo')} onClick={() => void moveRevision('undo')} disabled={!canUndo || saveState === 'saving'}><Undo2 className="size-4" /></Button></TooltipTrigger><TooltipContent>{t('editor.undo')}</TooltipContent></Tooltip><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-compact" type="button" aria-label={t('editor.redo')} onClick={() => void moveRevision('redo')} disabled={!canRedo || saveState === 'saving'}><Redo2 className="size-4" /></Button></TooltipTrigger><TooltipContent>{t('editor.redo')}</TooltipContent></Tooltip><Button variant="ghost" size="compact" onClick={() => setSettingsOpen(true)}><SlidersHorizontal className="size-4" />{t('editor.workflowSettings')}</Button><Button asChild variant="ghost" size="compact" className="hidden sm:inline-flex"><Link to="/workflows/$workflowId/versions" params={{ workflowId }}>{t('editor.versions')}</Link></Button><Button variant="ghost" size="compact" className="hidden sm:inline-flex" onClick={() => void exportWorkflow()} disabled={isNew}><Download className="size-4" />{t('editor.exportJson')}</Button><Button variant="ghost" size="icon-compact" className="hidden text-danger hover:text-danger sm:inline-flex" type="button" aria-label={t('delete.action', { name: existing?.name ?? name })} onClick={() => { setDeleteError(''); setDeleteOpen(true); }} disabled={isNew}><Trash2 className="size-4" /></Button><Button variant="secondary" size="compact" className="hidden sm:inline-flex" onClick={save} disabled={saveState === 'saving'}>{t('common:actions.save')}</Button><Button variant="secondary" size="compact" className="hidden sm:inline-flex" onClick={() => void runWorkflow()} disabled={runSubmitting || isNew || saveState !== 'saved' || !existing?.latestVersionId}>{runSubmitting ? t('editor.running') : existing?.latestVersion ? t('editor.runVersion', { version: existing.latestVersion }) : t('editor.run')}</Button><Button size="compact" onClick={() => setPublishOpen(true)}>{t('common:actions.publish')}</Button></div>}
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
            onEdgesChange={(changes) => { onEdgesChange(changes); for (const change of changes) { if (change.type === 'remove') clearEdgeValueState(change.id); } if (changes.some((change) => change.type === 'remove')) setSaveState('unsaved'); }}
            isValidConnection={(connection) => canConnect(connection, nodes, edges)}
            onConnect={handleConnect}
            onConnectEnd={handleConnectEnd}
            onReconnect={handleReconnect}
            onNodeClick={(_, node) => selectOnlyNode(node.id)}
            onEdgeClick={(_, edge) => selectOnlyEdge(edge.id)}
            onPaneClick={showNodePalette}
            onSelectionChange={({ nodes: selectedNodes, edges: selectedEdges }) => { if (selectedNodes.length + selectedEdges.length > 0 && !window.matchMedia('(min-width: 1024px)').matches) setContextPanelOpen(true); }}
            onNodesDelete={(deleted) => { if (deleted.length > 0) { const deletedIds = new Set(deleted.map((node) => node.id)); for (const edge of edges) { if (deletedIds.has(edge.source) || deletedIds.has(edge.target)) clearEdgeValueState(edge.id); } setEdges((current) => current.filter((edge) => !deletedIds.has(edge.source) && !deletedIds.has(edge.target))); setSaveState('unsaved'); } }}
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
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-h-[85vh] overflow-auto">
          <DialogHeader><DialogTitle>{t('editor.workflowSettings')}</DialogTitle><DialogDescription>{t('editor.workflowSettingsDescription')}</DialogDescription></DialogHeader>
          <div className="flex flex-col gap-5">
            <section><h3 className="text-sm font-semibold">{t('editor.general')}</h3><Field className="mt-3" label={t('editor.name')} htmlFor="wf-name"><Input id="wf-name" value={name} onChange={(event) => { setName(event.target.value); setSaveState('unsaved'); }} /></Field></section>
            <section><h3 className="text-sm font-semibold">{t('editor.inputs')}</h3><Field className="mt-3" label={t('editor.input')} htmlFor="wf-input"><Textarea id="wf-input" className="font-mono text-[13px]" value={input} onChange={(event) => { setInput(event.target.value); setSaveState('unsaved'); }} /></Field></section>
            <section>
              <h3 className="text-sm font-semibold">{t('editor.execution')}</h3>
              <Field className="mt-3" label={t('editor.defaultErrorPolicy')} htmlFor="default-policy"><Select value={executionPolicy} onValueChange={(value) => { setExecutionPolicy(value as 'stop' | 'retry'); setSaveState('unsaved'); }}><SelectTrigger id="default-policy"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="stop">{t('editor.stop')}</SelectItem><SelectItem value="retry">{t('editor.retry')}</SelectItem></SelectContent></Select></Field>
            </section>
            <section className="rounded-md border border-border bg-surface-subtle p-3"><h3 className="text-sm font-semibold">{t('editor.versioning')}</h3><p className="mt-1 text-[13px] text-muted-foreground">{t('editor.versioningHint')}</p></section>
          </div>
          <DialogFooter><Button onClick={() => setSettingsOpen(false)}>{t('common:actions.close')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Sheet open={contextPanelOpen} onOpenChange={setContextPanelOpen}><SheetContent side="right" className="overflow-auto p-4 pt-5"><SheetHeader className="sr-only"><SheetTitle>{selectedNode || selectedEdge ? t('editor.configureStep') : t('editor.nodePalette')}</SheetTitle><SheetDescription>{selectedNode || selectedEdge ? t('editor.selectCanvasItem') : t('editor.paletteHint')}</SheetDescription></SheetHeader>{contextPanel}</SheetContent></Sheet>
      <Dialog open={publishOpen} onOpenChange={setPublishOpen}><DialogContent><DialogHeader><DialogTitle>{t('editor.publishTitle')}</DialogTitle><DialogDescription>{t('editor.publishDescription')}</DialogDescription></DialogHeader><DialogFooter><Button variant="secondary" onClick={() => setPublishOpen(false)}>{t('common:actions.cancel')}</Button><Button onClick={() => void publishWorkflow()}>{t('common:actions.publish')}</Button></DialogFooter></DialogContent></Dialog>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(nextOpen) => { setDeleteOpen(nextOpen); if (!nextOpen) setDeleteError(''); }}
        title={t('delete.title', { name: existing?.name ?? name })}
        description={t('delete.description')}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        busyLabel={t('delete.deleting')}
        error={deleteError}
        busy={deleteBusy}
        onConfirm={() => void deleteWorkflow()}
      />
    </div>
  );
}

function toFlowNodes(definition: WorkflowDefinition): WorkflowCanvasNode[] {
  return definition.nodes.map((node) => {
    const config = asRecord(node.config);
    const nodeType = node.type === 'worklite/input' ? 'input' : node.type === 'worklite/timer' ? 'timer' : node.type === 'worklite/dashboard' ? 'dashboard' : node.type === 'worklite/artifact' ? 'artifact' : node.type === 'worklite/artifact-query' ? 'artifactQuery' : node.type === 'worklite/image' ? 'image' : node.type === 'wechat-official-account/publish' ? 'wechatPublish' : 'agent';
    const label = typeof config.label === 'string' ? config.label : nodeType === 'input' ? 'Workflow Input' : nodeType === 'timer' ? 'Timer' : nodeType === 'dashboard' ? 'Dashboard' : nodeType === 'artifact' ? 'Artifact' : nodeType === 'artifactQuery' ? 'Artifact Query' : nodeType === 'image' ? 'Image Generation' : nodeType === 'wechatPublish' ? 'WeChat Official Account' : 'Agent';
    return {
      id: node.id,
      type: nodeType,
      position: node.position,
      data: {
        nodeType,
        label,
        model: typeof config.model === 'string' ? config.model : '',
        systemPrompt: typeof config.systemPrompt === 'string' ? config.systemPrompt : '',
        outputFormat: config.outputFormat === 'json' || config.outputFormat === 'text' ? config.outputFormat : 'text',
        mcpServerIds: Array.isArray(config.mcpServerIds) ? config.mcpServerIds.filter((value): value is string => typeof value === 'string') : [],
        mcpServerNames: Array.isArray(config.mcpServerNames) ? config.mcpServerNames.filter((value): value is string => typeof value === 'string') : [],
        timerEnabled: typeof config.enabled === 'boolean' ? config.enabled : true,
        timerIntervalSeconds: typeof config.intervalSeconds === 'number' && Number.isFinite(config.intervalSeconds) ? config.intervalSeconds : 300,
        skillIds: Array.isArray(config.skillIds) ? config.skillIds.filter((value): value is string => typeof value === 'string') : [],
        skillNames: Array.isArray(config.skillNames) ? config.skillNames.filter((value): value is string => typeof value === 'string') : [],
        dashboardLayout: readDashboardLayout(config.layout),
        artifactName: typeof config.name === 'string' ? config.name : undefined,
        artifactType: config.type === 'json' || config.type === 'text' || config.type === 'markdown' ? config.type : undefined,
        queryName: typeof config.name === 'string' ? config.name : undefined,
        queryTitleField: typeof config.titleField === 'string' ? config.titleField : undefined,
        queryDescriptionFields: Array.isArray(config.descriptionFields) ? config.descriptionFields.filter((value): value is string => typeof value === 'string') : undefined,
        wechatAccountId: typeof config.accountId === 'string' ? config.accountId : undefined,
        wechatMode: config.mode === 'draft' || config.mode === 'publish' ? config.mode : undefined,
        wechatNodeVersion: node.typeVersion === '1' || node.typeVersion === '2' ? node.typeVersion : undefined,
        imageCount: typeof config.n === 'number' && Number.isInteger(config.n) ? config.n : 1,
        imageBackground: config.background === 'transparent' ? 'transparent' : 'opaque',
        imageQuality: config.quality === 'low' || config.quality === 'high' ? config.quality : 'medium',
        imageSize: config.size === '1536x1024' || config.size === '1024x1536' ? config.size : '1024x1024',
        errorPolicy: node.errorPolicy,
      },
    };
  });
}

function toFlowEdges(definition: WorkflowDefinition, t: TFunction<'workflows'>): WorkflowCanvasEdge[] {
  return definition.edges.map((edge) => applyEdgePresentation({
    id: edge.id,
    source: edge.sourceNodeId,
    sourceHandle: edge.sourcePort,
    target: edge.targetNodeId,
    targetHandle: edge.targetPort,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed },
    data: { condition: edge.condition, maxTraversals: edge.maxTraversals },
  }, t));
}

function applyEdgePresentation(edge: WorkflowCanvasEdge, t: TFunction<'workflows'>): WorkflowCanvasEdge {
  const condition = edge.data?.condition;
  const labels: string[] = [];
  if (condition?.kind === 'fallback') labels.push(t('editor.edgeModes.fallback'));
  if (condition?.kind === 'predicate') {
    const value = edgeOperatorRequiresValue(condition.operator) ? ` ${JSON.stringify(condition.value)}` : '';
    labels.push(`${condition.path} ${t(`editor.edgeOperators.${condition.operator}`)}${value}`);
  }
  if (edge.data?.maxTraversals !== undefined) labels.push(t('editor.edgeTraversalLabel', { count: edge.data.maxTraversals }));
  return {
    ...edge,
    label: labels.join(' · ') || undefined,
    labelStyle: { fill: 'currentColor', fontSize: 11 },
    labelBgStyle: { fill: 'var(--surface-raised)', fillOpacity: 0.92 },
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 3,
    style: edge.data?.maxTraversals !== undefined ? { ...edge.style, strokeDasharray: '6 4' } : { ...edge.style, strokeDasharray: undefined },
  };
}

function edgeOperatorRequiresValue(operator: WorkflowEdgePredicateOperator): boolean {
  return operator === 'equals' || operator === 'notEquals' || operator === 'greaterThan' || operator === 'greaterThanOrEqual' || operator === 'lessThan' || operator === 'lessThanOrEqual';
}

function canConnect(connection: { source: string | null; sourceHandle?: string | null; target: string | null; targetHandle?: string | null }, nodes: WorkflowCanvasNode[], edges: WorkflowCanvasEdge[]): boolean {
  const { source, sourceHandle, target, targetHandle } = connection;
  if (!source || !target || source === target || !targetHandle) return false;
  const sourceNode = nodes.find((node) => node.id === source);
  const targetNode = nodes.find((node) => node.id === target);
  if (!sourceNode || !targetNode) return false;
  const sourcePort = sourceHandle ?? 'output';
  if (sourcePort !== 'output') return false;
  const imageConnectionAllowed = sourceNode.data.nodeType !== 'image'
    || (targetNode.data.nodeType === 'wechatPublish'
      && targetNode.data.wechatNodeVersion !== '1'
      && targetHandle === 'coverImage');
  if (!imageConnectionAllowed) return false;
  if (targetNode.data.nodeType === 'dashboard' || targetNode.data.nodeType === 'artifact') {
    if (targetHandle !== 'data') return false;
  } else if (targetNode.data.nodeType === 'artifactQuery') {
    if (targetHandle !== 'request') return false;
  } else if (targetNode.data.nodeType === 'image') {
    if (targetHandle !== 'prompt') return false;
  } else if (targetNode.data.nodeType === 'wechatPublish') {
    if (targetNode.data.wechatNodeVersion === '1') {
      if (targetHandle !== 'article' && targetHandle !== 'metadata') return false;
    } else if (targetHandle !== 'article' && targetHandle !== 'metadata' && targetHandle !== 'coverImage') {
      return false;
    }
  } else if (targetNode.data.nodeType !== 'agent' || targetHandle !== 'context') {
    return false;
  }
  if (edges.some((edge) => edge.source === source && edge.target === target && (edge.sourceHandle ?? 'output') === sourcePort && (edge.targetHandle ?? 'input') === targetHandle)) return false;
  const incomingEdges = edges.filter((edge) => edge.target === target && (edge.targetHandle ?? 'input') === targetHandle);
  if (incomingEdges.length === 0) return true;
  if (targetNode.data.nodeType !== 'agent' || targetHandle !== 'context') return false;

  if (incomingEdges.length !== 1) return false;
  const existingIsBounded = incomingEdges[0].data?.maxTraversals !== undefined;
  const createsCycle = wouldCreateCycle(source, target, edges);
  if (sourceNode.data.nodeType === 'input') return existingIsBounded && !createsCycle;
  return existingIsBounded ? !createsCycle : createsCycle;
}

function wouldCreateCycle(source: string, target: string, edges: WorkflowCanvasEdge[]): boolean {
  const pending = [target];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    if (current === source) return true;
    visited.add(current);
    for (const edge of edges) if (edge.source === current && edge.data?.maxTraversals === undefined) pending.push(edge.target);
  }
  return false;
}

function toDefinitionNode(node: WorkflowCanvasNode): WorkflowNodeDefinition {
  const base = { label: node.data.label };
  let type = 'worklite/agent';
  let config: Record<string, unknown> = base;
  if (node.data.nodeType === 'input') {
    type = 'worklite/input';
  } else if (node.data.nodeType === 'timer') {
    type = 'worklite/timer';
    config = { ...base, enabled: node.data.timerEnabled !== false, intervalSeconds: node.data.timerIntervalSeconds ?? 300 };
  } else if (node.data.nodeType === 'dashboard') {
    type = 'worklite/dashboard';
    config = { ...base, layout: node.data.dashboardLayout ?? { header: [], main: [], footer: [] } };
  } else if (node.data.nodeType === 'artifact') {
    type = 'worklite/artifact';
    config = { ...base, name: node.data.artifactName ?? '', type: node.data.artifactType ?? 'text' };
  } else if (node.data.nodeType === 'artifactQuery') {
    type = 'worklite/artifact-query';
    config = { ...base, name: node.data.queryName ?? '', titleField: node.data.queryTitleField ?? '', descriptionFields: node.data.queryDescriptionFields ?? [] };
  } else if (node.data.nodeType === 'image') {
    type = 'worklite/image';
    config = {
      ...base,
      model: 'codex/gpt-image-2',
      n: node.data.imageCount ?? 1,
      background: node.data.imageBackground ?? 'opaque',
      quality: node.data.imageQuality ?? 'medium',
      size: node.data.imageSize ?? '1024x1024',
    };
  } else if (node.data.nodeType === 'wechatPublish') {
    type = 'wechat-official-account/publish';
    config = { ...base, accountId: node.data.wechatAccountId ?? 'wechat_official_account_personal', mode: node.data.wechatMode ?? 'draft' };
  } else {
    config = {
      ...base,
      model: node.data.model ?? '',
      systemPrompt: node.data.systemPrompt ?? '',
      outputFormat: node.data.outputFormat === 'json' ? 'json' : 'text',
      skillIds: node.data.skillIds ?? [],
      mcpServerIds: node.data.mcpServerIds ?? [],
    };
  }
  return {
    id: node.id,
    position: node.position,
    type,
    typeVersion: node.data.nodeType === 'wechatPublish' ? node.data.wechatNodeVersion ?? '2' : '1',
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

type DashboardLayoutRegion = 'header' | 'main' | 'footer';

const dashboardMetricFieldTypes = ['text', 'number', 'boolean', 'datetime'] as const;
const dashboardListFieldTypes = [...dashboardMetricFieldTypes, 'url'] as const;

function DashboardElementEditor({ idPrefix, element, t, onChange, onRemove }: {
  idPrefix: string;
  element: WorkflowDashboardElement;
  t: TFunction<'workflows'>;
  onChange: (element: WorkflowDashboardElement) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="grid gap-3">
        {element.kind === 'text' ? (
          <Field label={t('editor.elementTextLabel')} htmlFor={`${idPrefix}-text`}>
            <Textarea id={`${idPrefix}-text`} value={element.text} onChange={(event) => onChange({ kind: 'text', text: event.target.value })} />
          </Field>
        ) : null}
        {element.kind === 'count' || element.kind === 'metric' ? (
          <Field label={t('editor.elementLabel')} htmlFor={`${idPrefix}-label`}>
            <Input id={`${idPrefix}-label`} value={element.label} onChange={(event) => onChange({ ...element, label: event.target.value })} />
          </Field>
        ) : null}
        {element.kind === 'metric' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('editor.elementMetricField')} htmlFor={`${idPrefix}-field`}>
              <Input id={`${idPrefix}-field`} value={element.field} onChange={(event) => onChange({ ...element, field: event.target.value })} />
            </Field>
            <Field label={t('editor.fieldType')} htmlFor={`${idPrefix}-type`}>
              <Select value={element.type} onValueChange={(value) => onChange({ ...element, type: value as WorkflowDashboardFieldType })}>
                <SelectTrigger id={`${idPrefix}-type`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {dashboardMetricFieldTypes.map((type) => <SelectItem key={type} value={type}>{t(`editor.fieldTypes.${type}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </div>
        ) : null}
        {element.kind === 'list' ? (
          <>
            <Field label={t('editor.elementListTitleKey')} htmlFor={`${idPrefix}-title-key`}>
              <Select value={element.titleKey} onValueChange={(value) => onChange({ ...element, titleKey: value })}>
                <SelectTrigger id={`${idPrefix}-title-key`}><SelectValue /></SelectTrigger>
                <SelectContent>{element.fields.map((field) => <SelectItem key={field.key} value={field.key}>{field.label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <div>
              <p className="text-[12px] font-medium">{t('editor.dashboardFields')}</p>
              <div className="mt-2 space-y-2">
                {element.fields.map((field, fieldIndex) => (
                  <div key={fieldIndex} className="rounded-md border border-border p-2">
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Field label={t('editor.fieldKey')} htmlFor={`${idPrefix}-field-key-${fieldIndex}`}>
                        <Input id={`${idPrefix}-field-key-${fieldIndex}`} value={field.key} onChange={(event) => { const key = event.target.value; onChange({ ...element, fields: element.fields.map((item, itemIndex) => itemIndex === fieldIndex ? { ...item, key } : item) }); }} />
                      </Field>
                      <Field label={t('editor.fieldLabel')} htmlFor={`${idPrefix}-field-label-${fieldIndex}`}>
                        <Input id={`${idPrefix}-field-label-${fieldIndex}`} value={field.label} onChange={(event) => { const label = event.target.value; onChange({ ...element, fields: element.fields.map((item, itemIndex) => itemIndex === fieldIndex ? { ...item, label } : item) }); }} />
                      </Field>
                      <Field label={t('editor.fieldType')} htmlFor={`${idPrefix}-field-type-${fieldIndex}`}>
                        <Select value={field.type} onValueChange={(value) => { const type = value as WorkflowDashboardFieldType; onChange({ ...element, fields: element.fields.map((item, itemIndex) => itemIndex === fieldIndex ? { ...item, type } : item) }); }}>
                          <SelectTrigger id={`${idPrefix}-field-type-${fieldIndex}`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {dashboardListFieldTypes.map((type) => <SelectItem key={type} value={type}>{t(`editor.fieldTypes.${type}`)}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </Field>
                    </div>
                    <Button type="button" variant="ghost" size="compact" className="mt-1 text-muted-foreground" disabled={element.fields.length <= 1} onClick={() => onChange({ ...element, fields: element.fields.filter((_, itemIndex) => itemIndex !== fieldIndex) })}>
                      <Trash2 className="size-4" />{t('editor.removeDashboardField')}
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                type="button"
                variant="secondary"
                size="compact"
                className="mt-2"
                onClick={() => {
                  const fields = element.fields;
                  let suffix = fields.length + 1;
                  while (fields.some((item) => item.key === `field_${suffix}`)) suffix += 1;
                  onChange({ ...element, fields: [...fields, { key: `field_${suffix}`, label: t('editor.newFieldLabel'), type: 'text' }] });
                }}
              >
                <Plus className="size-4" />{t('editor.addDashboardField')}
              </Button>
            </div>
          </>
        ) : null}
      </div>
      <Button type="button" variant="ghost" size="compact" className="mt-2 text-muted-foreground" onClick={onRemove}>
        <Trash2 className="size-4" />{t('editor.removeDashboardElement')}
      </Button>
    </div>
  );
}

function readDashboardLayout(value: unknown): WorkflowDashboardLayout {
  const empty: WorkflowDashboardLayout = { header: [], main: [], footer: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
  const layout = value as Record<string, unknown>;
  return {
    header: readDashboardElements(layout.header),
    main: readDashboardElements(layout.main),
    footer: readDashboardElements(layout.footer),
  };
}

function readDashboardElements(value: unknown): WorkflowDashboardElement[] {
  if (!Array.isArray(value)) return [];
  const supportedType = (candidate: unknown): candidate is WorkflowDashboardFieldType => candidate === 'text' || candidate === 'number' || candidate === 'boolean' || candidate === 'datetime' || candidate === 'url';
  const supportedMetricType = (candidate: unknown): candidate is WorkflowDashboardFieldType => candidate === 'text' || candidate === 'number' || candidate === 'boolean' || candidate === 'datetime';
  return value.flatMap((item): WorkflowDashboardElement[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const element = item as Record<string, unknown>;
    if (element.kind === 'text' && typeof element.text === 'string') return [{ kind: 'text', text: element.text }];
    if (element.kind === 'count' && typeof element.label === 'string') return [{ kind: 'count', label: element.label }];
    if (element.kind === 'metric' && typeof element.label === 'string' && typeof element.field === 'string' && supportedMetricType(element.type)) return [{ kind: 'metric', label: element.label, field: element.field, type: element.type }];
    if (element.kind === 'list' && typeof element.titleKey === 'string' && Array.isArray(element.fields)) {
      const fields: WorkflowDashboardField[] = [];
      for (const field of element.fields) {
        if (!field || typeof field !== 'object' || Array.isArray(field)) continue;
        const record = field as Record<string, unknown>;
        if (typeof record.key === 'string' && typeof record.label === 'string' && supportedType(record.type)) fields.push({ key: record.key, label: record.label, type: record.type });
      }
      return [{ kind: 'list', titleKey: element.titleKey, fields }];
    }
    return [];
  });
}

function nodeTypeLabel(nodeType: WorkflowCanvasNode['data']['nodeType'], t: TFunction<'workflows'>): string {
  if (nodeType === 'input') return t('editor.workflowInputNode');
  if (nodeType === 'timer') return t('editor.timerNode');
  if (nodeType === 'dashboard') return t('editor.dashboardNode');
  if (nodeType === 'artifact') return t('editor.artifactNode');
  if (nodeType === 'artifactQuery') return t('editor.artifactQueryNode');
  if (nodeType === 'image') return t('editor.imageNode');
  if (nodeType === 'wechatPublish') return t('editor.wechatNode');
  return t('editor.agentNode');
}

function PaletteButton({ icon, title, description, onClick }: { icon: ReactNode; title: string; description: string; onClick: () => void }) {
  return <button type="button" className="flex w-full items-center gap-3 rounded-md border border-transparent px-2 py-2 text-left transition-colors duration-[120ms] hover:border-border hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45" onClick={onClick}>{icon}<span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{title}</span><span className="block truncate text-[12px] text-muted-foreground">{description}</span></span><Plus className="size-4 text-muted-foreground" aria-hidden="true" /></button>;
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
