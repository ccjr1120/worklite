import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { RunView, WorkflowNodeDefinition, WorkflowNodeRunView } from '@worklite/contracts';
import { StatusBadge } from '@/components/status-badge';
import { WorkflowStageNode, workflowNodeInputs, workflowNodePortOffset, workflowNodeRowCount, type WorkflowCanvasEdge, type WorkflowCanvasNode, type WorkflowCanvasNodeType } from '@/components/workflow-canvas-nodes';
import { calculateWorkflowFlowLayout } from '@/components/workflow-flow-layout';
import { useWorkflowVersionsQuery } from '@/api/queries';
import { durationParts, formatDateTime } from '@/i18n/format';
import type { AppLocale } from '@/i18n/locale';
import { cn } from '@/lib/utils';
import { readNodeIdentity } from './node-identity';
import { NodeRunLogEntry, toRecordStatus } from './node-run-log';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 128;

type RunExecutionViewProps = {
  run: RunView | undefined;
  locale: AppLocale;
  loading: boolean;
  failed: boolean;
  compact?: boolean;
};

function edgePath(source: { x: number; y: number }, target: { x: number; y: number }): string {
  const direction = target.x >= source.x ? 1 : -1;
  const curve = Math.max(40, Math.abs(target.x - source.x) * 0.48);
  return `M ${source.x} ${source.y} C ${source.x + direction * curve} ${source.y}, ${target.x - direction * curve} ${target.y}, ${target.x} ${target.y}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nodeTypeFor(node: WorkflowNodeDefinition): WorkflowCanvasNodeType {
  const types: Record<string, WorkflowCanvasNodeType> = {
    'worklite/input': 'input',
    'worklite/timer': 'timer',
    'worklite/branch': 'branch',
    'typesafe/systemone': 'systemOne',
    'typesafe/systemone-map': 'systemOneMap',
    'worklite/dashboard': 'dashboard',
    'worklite/artifact': 'artifact',
    'worklite/artifact-query': 'artifactQuery',
    'worklite/image': 'image',
    'worklite/canvas-sticker': 'canvasSticker',
    'worklite/canvas-render': 'canvasRender',
    'worklite/map': 'map',
    'worklite/join': 'join',
    'worklite/compose-article': 'compose',
    'wechat-official-account/publish': 'wechatPublish',
    'worklite/agent': 'agent',
  };
  return types[node.type] ?? 'agent';
}

function toFlowNode(node: WorkflowNodeDefinition, t: TFunction<'workflows'>): WorkflowCanvasNode {
  const config = asRecord(node.config);
  const nodeType = nodeTypeFor(node);
  const fallbackLabels: Record<WorkflowCanvasNodeType, string> = {
    input: t('editor.workflowInputNode'),
    timer: t('editor.timerNode'),
    agent: t('editor.agentNode'),
    branch: t('editor.branchNode'),
    systemOne: t('editor.systemOneNode'),
    systemOneMap: t('editor.systemOneMapNode'),
    dashboard: t('editor.dashboardNode'),
    artifact: t('editor.artifactNode'),
    artifactQuery: t('editor.artifactQueryNode'),
    wechatPublish: t('editor.wechatNode'),
    image: t('editor.imageNode'),
    canvasSticker: t('editor.stickerNode'),
    canvasRender: t('editor.renderNode'),
    map: t('editor.mapNode'),
    join: t('editor.joinNode'),
    compose: t('editor.composeNode'),
  };
  const identity = readNodeIdentity(config, fallbackLabels[nodeType]);
  return {
    id: node.id,
    type: nodeType,
    position: node.position,
    data: {
      nodeType,
      label: identity.label,
      ...(identity.description ? { description: identity.description } : {}),
      errorPolicy: node.errorPolicy,
      wechatNodeVersion: node.typeVersion === '1' ? '1' : '2',
    },
  };
}

function edgeConditionLabel(edge: WorkflowCanvasEdge, t: TFunction<'workflows'>): string | undefined {
  const condition = edge.data?.condition;
  if (!condition) return undefined;
  if (condition.kind === 'fallback') return t('editor.edgeModes.fallback');
  const pathParts = condition.path.replace(/^\$\.?/, '').split('.').filter(Boolean);
  const path = pathParts.at(-1) === 'choice' ? pathParts.at(-2) ?? condition.path : pathParts.at(-1) ?? condition.path;
  const symbols: Record<string, string> = {
    equals: '=',
    notEquals: '≠',
    truthy: '?',
    falsy: '!',
    exists: '∃',
    notExists: '∄',
    greaterThan: '>',
    greaterThanOrEqual: '≥',
    lessThan: '<',
    lessThanOrEqual: '≤',
  };
  const hasValue = ['equals', 'notEquals', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual'].includes(condition.operator);
  const value = typeof condition.value === 'string' ? condition.value || '""' : JSON.stringify(condition.value) ?? String(condition.value);
  const label = condition.operator === 'equals' ? value : `${path} ${symbols[condition.operator] ?? ''}${hasValue ? ` ${value}` : ''}`;
  return label.length > 28 ? `${label.slice(0, 25)}…` : label;
}

function versionNumber(version: string): number | null {
  const match = version.match(/^v(\d+)$/);
  return match ? Number(match[1]) : null;
}

function RunExecutionView({ run, locale, loading, failed, compact = false }: RunExecutionViewProps) {
  const { t: tRun } = useTranslation('runs');
  const { t: tWorkflow } = useTranslation('workflows');
  const { t: tCommon } = useTranslation('common');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const initializedRunRef = useRef<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const markerId = `run-flow-arrow-${useId().split(':').join('')}`;
  const workflowId = run?.workflowId ?? '';
  const { data: versions, isLoading: loadingVersion, isError: failedVersion } = useWorkflowVersionsQuery('personal', workflowId);
  const runVersionNumber = run ? versionNumber(run.version) : null;
  const definition = versions?.find((version) => version.version === runVersionNumber)?.definition;
  const nodeRuns = useMemo(() => [...(run?.nodeRuns ?? [])].sort((left, right) => left.position - right.position), [run?.nodeRuns]);
  const invocationMap = useMemo(() => {
    const map = new Map<string, WorkflowNodeRunView[]>();
    for (const nodeRun of nodeRuns) map.set(nodeRun.nodeId, [...(map.get(nodeRun.nodeId) ?? []), nodeRun]);
    return map;
  }, [nodeRuns]);
  const { nodes, edges, nodeById } = useMemo(() => {
    if (!definition) return { nodes: [] as WorkflowCanvasNode[], edges: [] as WorkflowCanvasEdge[], nodeById: new Map<string, WorkflowCanvasNode>() };
    const rawNodes = definition.nodes.map((node) => toFlowNode(node, tWorkflow));
    const rawEdges: WorkflowCanvasEdge[] = definition.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceNodeId,
      sourceHandle: edge.sourcePort,
      target: edge.targetNodeId,
      targetHandle: edge.targetPort,
      data: { condition: edge.condition, maxTraversals: edge.maxTraversals },
    }));
    const positions = calculateWorkflowFlowLayout(rawNodes, rawEdges);
    const laidOutNodes = rawNodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position }));
    return { nodes: laidOutNodes, edges: rawEdges, nodeById: new Map(laidOutNodes.map((node) => [node.id, node])) };
  }, [definition, tWorkflow]);
  const edgeStates = useMemo(() => {
    const states = new Map<string, { traversed: number; skipped: number }>();
    for (const nodeRun of nodeRuns) {
      for (const activity of nodeRun.activity) {
        if (activity.detail.phase !== 'edge.decision') continue;
        for (const decision of activity.detail.decisions) {
          const state = states.get(decision.edgeId) ?? { traversed: 0, skipped: 0 };
          if (decision.traversed) state.traversed += 1;
          else state.skipped += 1;
          states.set(decision.edgeId, state);
        }
      }
    }
    return states;
  }, [nodeRuns]);
  const contentMetrics = useMemo(() => {
    const maxRight = nodes.reduce((value, node) => Math.max(value, node.position.x + NODE_WIDTH), 0);
    const maxBottom = nodes.reduce((value, node) => Math.max(value, node.position.y + NODE_HEIGHT), 0);
    const backwardEdges = edges.filter((edge) => {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      return source && target && target.position.x <= source.position.x;
    });
    return {
      width: Math.max(480, maxRight + 48),
      height: Math.max(300, maxBottom + 48 + backwardEdges.length * 26),
      backwardEdgeIds: new Set(backwardEdges.map((edge) => edge.id)),
      backwardEdgeOrder: new Map(backwardEdges.map((edge, index) => [edge.id, index])),
    };
  }, [edges, nodeById, nodes]);
  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) : undefined;
  const selectedNodeRuns = selectedNodeId ? invocationMap.get(selectedNodeId) ?? [] : [];

  useEffect(() => {
    if (!run || !definition || nodeRuns.length === 0 || initializedRunRef.current === run.id) return;
    initializedRunRef.current = run.id;
    const activeNodeId = run.currentStep && nodeById.has(run.currentStep) ? run.currentStep : null;
    const failedNodeId = [...nodeRuns].reverse().find((nodeRun) => nodeRun.retryable || nodeRun.status === 'failed')?.nodeId ?? null;
    const preferredNodeId = activeNodeId ?? failedNodeId;
    if (preferredNodeId) setSelectedNodeId(preferredNodeId);
  }, [definition, nodeById, nodeRuns, run]);

  useEffect(() => {
    if (!selectedNodeId) return;
    const viewport = viewportRef.current;
    const nodeElement = Array.from(viewport?.querySelectorAll<HTMLElement>('[data-flow-node]') ?? []).find((element) => element.dataset.flowNode === selectedNodeId);
    if (!viewport || !nodeElement) return;
    const viewportBounds = viewport.getBoundingClientRect();
    const nodeBounds = nodeElement.getBoundingClientRect();
    const margin = 24;
    let left = 0;
    let top = 0;
    if (nodeBounds.left < viewportBounds.left + margin) left = nodeBounds.left - viewportBounds.left - margin;
    else if (nodeBounds.right > viewportBounds.right - margin) left = nodeBounds.right - viewportBounds.right + margin;
    if (nodeBounds.top < viewportBounds.top + margin) top = nodeBounds.top - viewportBounds.top - margin;
    else if (nodeBounds.bottom > viewportBounds.bottom - margin) top = nodeBounds.bottom - viewportBounds.bottom + margin;
    if (left || top) {
      viewport.scrollBy({ left, top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }, [selectedNodeId]);

  function portPosition(nodeId: string, type: 'source' | 'target', portId: string): { x: number; y: number } | null {
    const node = nodeById.get(nodeId);
    if (!node) return null;
    const rows = workflowNodeRowCount(node, tWorkflow);
    if (type === 'source') return { x: node.position.x + NODE_WIDTH, y: node.position.y + workflowNodePortOffset(rows, rows - 1) };
    const inputIndex = workflowNodeInputs(node, tWorkflow).findIndex((input) => input.id === portId);
    if (inputIndex < 0) return null;
    return { x: node.position.x, y: node.position.y + workflowNodePortOffset(rows, inputIndex) };
  }

  if (loading) return <p className="mt-2 text-[13px] text-muted-foreground">{tRun('logsLoading')}</p>;
  if (failed) return <p className="mt-2 text-[13px] text-danger" role="alert">{tRun('logsFailed')}</p>;
  if (!run) return <p className="mt-2 text-[13px] text-muted-foreground">{tRun('noLogs')}</p>;
  if (loadingVersion) return <p className="mt-2 text-[13px] text-muted-foreground">{tRun('logsLoading')}</p>;
  if (failedVersion || !definition) return <p className="mt-2 text-[13px] text-danger" role="alert">{tRun('logsFailed')}</p>;

  return (
    <div className="mt-2" role="group" aria-label={tRun('logs')}>
      <div className={cn('relative w-full overflow-hidden rounded-md border border-border bg-background', compact ? 'h-[300px]' : 'h-[min(52vh,480px)] min-h-[300px]')}>
        <div
          ref={viewportRef}
          className="workflow-flow-viewport"
          role="region"
          aria-label={tRun('logs')}
          tabIndex={0} /* The scroll region is focusable so keyboard users can traverse the graph. */ /* eslint-disable-line jsx-a11y/no-noninteractive-tabindex */
        >
          <div className="workflow-flow-content" style={{ width: contentMetrics.width, height: contentMetrics.height }}>
            <svg className="workflow-flow-edges" width={contentMetrics.width} height={contentMetrics.height} aria-hidden="false">
              <defs>
                <marker id={markerId} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="strokeWidth" viewBox="0 0 10 10">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
                </marker>
              </defs>
              {edges.map((edge) => {
                const sourceNode = nodeById.get(edge.source);
                const targetNode = nodeById.get(edge.target);
                if (!sourceNode || !targetNode) return null;
                const source = portPosition(edge.source, 'source', edge.sourceHandle ?? 'output');
                const target = portPosition(edge.target, 'target', edge.targetHandle ?? 'input');
                if (!source || !target) return null;
                const feedback = contentMetrics.backwardEdgeIds.has(edge.id);
                const loopY = contentMetrics.height - 48 - ((contentMetrics.backwardEdgeOrder.get(edge.id) ?? 0) * 26);
                const path = feedback
                  ? `M ${source.x} ${source.y} C ${source.x + 32} ${source.y}, ${source.x + 32} ${loopY}, ${source.x + 64} ${loopY} L ${target.x - 64} ${loopY} C ${target.x - 32} ${loopY}, ${target.x - 32} ${target.y}, ${target.x} ${target.y}`
                  : edgePath(source, target);
                const state = edgeStates.get(edge.id);
                const targetPort = workflowNodeInputs(targetNode, tWorkflow).find((input) => input.id === (edge.targetHandle ?? 'input'))?.label ?? tWorkflow('editor.inputPort');
                const routeDescription = [
                  state?.traversed ? tRun('nodeLog.edgeTraversed', { target: targetNode.data.label, port: targetPort }) : '',
                  state?.skipped ? tRun('nodeLog.edgeSkipped', { target: targetNode.data.label, port: targetPort }) : '',
                ].filter(Boolean).join(', ');
                const ariaLabel = `${sourceNode.data.label} ${tWorkflow('editor.outputPort')} → ${targetNode.data.label} ${targetPort}${routeDescription ? `, ${routeDescription}` : ''}`;
                const conditionLabel = edgeConditionLabel(edge, tWorkflow);
                const traversalLabel = [
                  state?.traversed ? `✓ ×${state.traversed}` : '',
                  state?.skipped ? `— ×${state.skipped}` : '',
                ].filter(Boolean).join(' ');
                const edgeLabel = [conditionLabel, traversalLabel].filter(Boolean).join(' · ');
                const labelX = (source.x + target.x) / 2;
                const labelY = feedback ? loopY - 7 : (source.y + target.y) / 2 - 7;
                const labelWidth = edgeLabel ? Math.min(240, Math.max(24, edgeLabel.length * 6.2 + 12)) : 0;
                return (
                  <g
                    key={edge.id}
                    className={cn(
                      'workflow-flow-edge workflow-run-edge',
                      feedback && 'workflow-edge-bounded',
                      state?.traversed && 'workflow-run-edge-traversed',
                      !state?.traversed && state?.skipped && 'workflow-run-edge-skipped',
                    )}
                    role="img"
                    aria-label={ariaLabel}
                  >
                    <title>{ariaLabel}</title>
                    <path d={path} className="workflow-edge-visible" markerEnd={`url(#${markerId})`} />
                    {edgeLabel ? <>
                      <rect className="workflow-edge-label-background" x={labelX - labelWidth / 2} y={labelY - 9} width={labelWidth} height="18" rx="4" />
                      <text className="workflow-edge-label" x={labelX} y={labelY + 1}>{edgeLabel}</text>
                    </> : null}
                  </g>
                );
              })}
            </svg>
            {nodes.map((node) => {
              const invocations = invocationMap.get(node.id) ?? [];
              const latest = invocations.at(-1);
              const status = latest ? toRecordStatus(latest.status) : null;
              const statusLabel = status ? tCommon(`status.${status}`) : '';
              return (
                <div key={node.id} className="workflow-flow-node-position" style={{ left: node.position.x, top: node.position.y }}>
                  <WorkflowStageNode
                    node={{ ...node, className: status ? `workflow-run-node-${status}` : undefined }}
                    selected={selectedNodeId === node.id}
                    keyboardSource={false}
                    readOnly
                    statusDescription={status ? `${statusLabel}, ×${invocations.length}` : undefined}
                    statusIndicator={status ? (
                      <span className="workflow-run-node-indicator">
                        <StatusBadge status={status} className="workflow-run-node-badge" />
                        <span className="workflow-run-node-visits">×{invocations.length}</span>
                      </span>
                    ) : null}
                    onSelect={(nodeId) => setSelectedNodeId((current) => current === nodeId ? null : nodeId)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <section className="mt-4" aria-labelledby={`run-trace-${run.id}-title`}>
        <h4 id={`run-trace-${run.id}-title`} className="text-sm font-semibold">{tRun('nodeLog.activity')}</h4>
        {nodeRuns.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted-foreground">{tRun('detail.noNodeRuns')}</p>
        ) : (
          <ol className="mt-2 grid gap-2">
            {nodeRuns.map((nodeRun) => {
              const node = nodeById.get(nodeRun.nodeId);
              const label = node?.data.label ?? nodeRun.nodeId;
              const duration = nodeRun.startedAt && nodeRun.finishedAt
                ? durationParts(Math.max(0, Math.round((Date.parse(nodeRun.finishedAt) - Date.parse(nodeRun.startedAt)) / 1000)))
                : null;
              const edgeActivities = nodeRun.activity
                .filter((activity) => activity.detail.phase === 'edge.decision')
                .sort((left, right) => left.sequence - right.sequence);
              return (
                <li key={nodeRun.id} className="border-l-2 border-border pl-3">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <button
                      type="button"
                      className="text-left text-[13px] font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45"
                      aria-pressed={selectedNodeId === nodeRun.nodeId}
                      onClick={() => setSelectedNodeId(nodeRun.nodeId)}
                    >
                      {label} <span className="font-mono text-[11px] text-muted-foreground">#{nodeRun.position}</span>
                    </button>
                    <StatusBadge status={toRecordStatus(nodeRun.status)} />
                    {nodeRun.startedAt ? <time className="text-[11px] tabular-nums text-muted-foreground">{formatDateTime(nodeRun.startedAt, locale)}</time> : null}
                    {duration ? <span className="text-[11px] tabular-nums text-muted-foreground">{tCommon('duration.compact', duration)}</span> : null}
                  </div>
                  {edgeActivities.length > 0 ? (
                    <ol className="mt-1 grid gap-1 pl-2">
                      {edgeActivities.map((activity) => {
                        if (activity.detail.phase !== 'edge.decision') return null;
                        return (
                          <li key={activity.sequence} className="text-[12px] text-muted-foreground">
                            <time className="mr-2 tabular-nums">{formatDateTime(activity.occurredAt, locale)}</time>
                            {activity.detail.decisions.map((decision) => {
                              const targetLabel = nodeById.get(decision.targetNodeId)?.data.label ?? decision.targetNodeId;
                              return (
                                <span key={decision.edgeId} className="mr-2 inline-block">
                                  {decision.traversed
                                    ? tRun('nodeLog.edgeTraversed', { target: targetLabel, port: decision.targetPort })
                                    : tRun('nodeLog.edgeSkipped', { target: targetLabel, port: decision.targetPort })}
                                  {' · '}{decision.condition}
                                  {decision.maxTraversals !== null ? ` · ${tRun('nodeLog.edgeTraversals', { count: decision.traversals, max: decision.maxTraversals })}` : ''}
                                </span>
                              );
                            })}
                            {activity.detail.terminal && activity.detail.decisions.length === 0 ? tRun('nodeLog.edgeTerminal') : null}
                          </li>
                        );
                      })}
                    </ol>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {selectedNode ? (
        <section className="mt-4 max-h-[40vh] overflow-auto rounded-xl border border-border bg-surface p-3 shadow-xs" aria-labelledby={`run-node-details-${run.id}-title`}>
          <header className="mb-2">
            <h4 id={`run-node-details-${run.id}-title`} className="text-sm font-semibold">{selectedNode.data.label}</h4>
            {selectedNode.data.description ? <p className="mt-1 text-[12px] text-muted-foreground">{selectedNode.data.description}</p> : null}
          </header>
          {selectedNodeRuns.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{tRun('noLogs')}</p>
          ) : (
            <ol className="grid gap-2">
              {selectedNodeRuns.map((nodeRun) => (
                <NodeRunLogEntry key={nodeRun.id} nodeRun={nodeRun} locale={locale} runId={run.id} nodeLabel={selectedNode.data.label} />
              ))}
            </ol>
          )}
        </section>
      ) : null}
    </div>
  );
}

export { RunExecutionView };
