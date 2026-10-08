import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { WorkflowStageNode, workflowNodeInputs as nodeInputs, workflowNodePortOffset, workflowNodeRowCount, type WorkflowCanvasEdge, type WorkflowCanvasNode, type WorkflowCanvasNodeType, type WorkflowConnection } from '@/components/workflow-canvas-nodes';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 128;

type PortTarget = { type: 'source' | 'target'; nodeId: string; portId: string };
type ConnectionGesture = {
  edge?: WorkflowCanvasEdge;
  side?: 'source' | 'target';
  sourceNodeId: string | null;
  sourcePort: string;
  targetNodeId: string | null;
  targetPort: string;
  pointer: { x: number; y: number; clientX: number; clientY: number };
  candidate?: PortTarget & { valid: boolean };
};

function edgePath(source: { x: number; y: number }, target: { x: number; y: number }): string {
  const direction = target.x >= source.x ? 1 : -1;
  const curve = Math.max(40, Math.abs(target.x - source.x) * 0.48);
  return `M ${source.x} ${source.y} C ${source.x + direction * curve} ${source.y}, ${target.x - direction * curve} ${target.y}, ${target.x} ${target.y}`;
}

export function WorkflowFlowDiagram({
  nodes,
  edges,
  viewportRef,
  toolbar,
  emptyState,
  renderNodePicker,
  isValidConnection,
  onConnect,
  onReconnect,
  onAddNode,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
  onRemoveNode,
  onRemoveEdge,
}: {
  nodes: WorkflowCanvasNode[];
  edges: WorkflowCanvasEdge[];
  viewportRef: RefObject<HTMLDivElement | null>;
  toolbar: (openNodePicker: () => void) => ReactNode;
  emptyState: ReactNode;
  renderNodePicker: (sourceNodeId: string | null, onSelect: (nodeType: WorkflowCanvasNodeType) => void) => ReactNode;
  isValidConnection: (connection: WorkflowConnection, ignoreEdgeId?: string) => boolean;
  onConnect: (connection: WorkflowConnection) => void;
  onReconnect: (edge: WorkflowCanvasEdge, connection: WorkflowConnection) => void;
  onAddNode: (nodeType: WorkflowCanvasNodeType, sourceNodeId?: string) => void;
  onSelectNode: (nodeId: string) => void;
  onSelectEdge: (edgeId: string) => void;
  onClearSelection: () => void;
  onRemoveNode: (nodeId: string) => void;
  onRemoveEdge: (edgeId: string) => void;
}) {
  const { t } = useTranslation('workflows');
  const markerId = `workflow-arrow-${useId().split(':').join('')}`;
  const [gesture, setGesture] = useState<ConnectionGesture | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<{ left: number; top: number; width: number; maxHeight: number; sourceNodeId: string | null } | null>(null);
  const [keyboardSource, setKeyboardSource] = useState<{ nodeId: string; portId: string } | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selectedNodeId = nodes.find((node) => node.selected)?.id;
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

  function rowCount(node: WorkflowCanvasNode) {
    return workflowNodeRowCount(node, t);
  }

  function portPosition(nodeId: string, type: 'source' | 'target', portId: string): { x: number; y: number } | null {
    const node = nodeById.get(nodeId);
    if (!node) return null;
    const rows = rowCount(node);
    if (type === 'source') return { x: node.position.x + NODE_WIDTH, y: node.position.y + workflowNodePortOffset(rows, rows - 1) };
    const inputs = workflowInputs(node);
    const inputIndex = inputs.findIndex((input) => input.id === portId);
    if (inputIndex < 0) return null;
    return { x: node.position.x, y: node.position.y + workflowNodePortOffset(rows, inputIndex) };
  }

  function workflowInputs(node: WorkflowCanvasNode) {
    return nodeInputs(node, t);
  }

  const canvasPoint = useCallback((clientX: number, clientY: number) => {
    const viewport = viewportRef.current;
    const bounds = viewport?.getBoundingClientRect();
    return {
      x: clientX - (bounds?.left ?? 0) + (viewport?.scrollLeft ?? 0),
      y: clientY - (bounds?.top ?? 0) + (viewport?.scrollTop ?? 0),
    };
  }, [viewportRef]);

  const portAt = useCallback((clientX: number, clientY: number): PortTarget | undefined => {
    const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-flow-port-type][data-flow-node-id][data-flow-port-id]');
    if (!target) return undefined;
    const type = target.dataset.flowPortType;
    const nodeId = target.dataset.flowNodeId;
    const portId = target.dataset.flowPortId;
    if ((type !== 'source' && type !== 'target') || !nodeId || !portId) return undefined;
    return { type, nodeId, portId };
  }, []);

  const openNodePicker = useCallback((sourceNodeId: string | null = null, clientX?: number, clientY?: number) => {
    const viewport = viewportRef.current;
    const bounds = viewport?.getBoundingClientRect();
    if (!viewport || !bounds) return;
    onClearSelection();
    const width = Math.max(0, Math.min(320, bounds.width - 24));
    const maxHeight = Math.max(0, Math.min(420, bounds.height - 24));
    const anchorX = clientX ?? bounds.right - width - 12;
    const anchorY = clientY ?? bounds.top + 56;
    const left = Math.max(bounds.left + 12, Math.min(anchorX, bounds.right - width - 12));
    const top = Math.max(bounds.top + 12, Math.min(anchorY, bounds.bottom - maxHeight - 12));
    setPickerAnchor({ left, top, width, maxHeight, sourceNodeId });
  }, [onClearSelection, viewportRef]);

  useEffect(() => {
    if (!pickerAnchor) return;
    const initialFocus = window.matchMedia('(pointer: coarse)').matches
      ? pickerRef.current?.querySelector<HTMLElement>('button') ?? pickerRef.current
      : pickerRef.current?.querySelector<HTMLElement>('input');
    initialFocus?.focus();
    const dismissOutside = (event: PointerEvent) => {
      if (pickerRef.current?.contains(event.target as Node)) return;
      setPickerAnchor(null);
    };
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [pickerAnchor]);

  const connectionFor = useCallback((gestureValue: ConnectionGesture, port?: PortTarget): WorkflowConnection | null => {
    if (gestureValue.edge && gestureValue.side === 'source') {
      if (!port || port.type !== 'source' || !gestureValue.targetNodeId) return null;
      return { source: port.nodeId, sourceHandle: port.portId, target: gestureValue.targetNodeId, targetHandle: gestureValue.targetPort };
    }
    if (gestureValue.edge && gestureValue.side === 'target') {
      if (!port || port.type !== 'target' || !gestureValue.sourceNodeId) return null;
      return { source: gestureValue.sourceNodeId, sourceHandle: gestureValue.sourcePort, target: port.nodeId, targetHandle: port.portId };
    }
    if (!port || port.type !== 'target' || !gestureValue.sourceNodeId) return null;
    return { source: gestureValue.sourceNodeId, sourceHandle: gestureValue.sourcePort, target: port.nodeId, targetHandle: port.portId };
  }, []);

  function beginPointerConnection(nodeId: string, portId: string, event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const pointer = canvasPoint(event.clientX, event.clientY);
    setGesture({ sourceNodeId: nodeId, sourcePort: portId, targetNodeId: null, targetPort: '', pointer: { ...pointer, clientX: event.clientX, clientY: event.clientY } });
    setKeyboardSource(null);
  }

  function beginReconnect(edge: WorkflowCanvasEdge, side: 'source' | 'target', event: ReactPointerEvent<SVGCircleElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const sourceNodeId = side === 'target' ? edge.source : null;
    const targetNodeId = side === 'source' ? edge.target : null;
    const pointer = canvasPoint(event.clientX, event.clientY);
    setGesture({
      edge,
      side,
      sourceNodeId,
      sourcePort: edge.sourceHandle ?? 'output',
      targetNodeId,
      targetPort: edge.targetHandle ?? 'input',
      pointer: { ...pointer, clientX: event.clientX, clientY: event.clientY },
    });
  }

  useEffect(() => {
    if (!gesture) return;
    const update = (event: PointerEvent) => {
      const port = portAt(event.clientX, event.clientY);
      const candidateConnection = connectionFor(gesture, port);
      const valid = candidateConnection ? isValidConnection(candidateConnection, gesture.edge?.id) : false;
      const pointer = canvasPoint(event.clientX, event.clientY);
      setGesture((current) => current ? {
        ...current,
        pointer: { ...pointer, clientX: event.clientX, clientY: event.clientY },
        candidate: port ? { ...port, valid } : undefined,
      } : current);
    };
    const finish = (event: PointerEvent) => {
      if (event.type === 'pointercancel') {
        setGesture(null);
        return;
      }
      const port = portAt(event.clientX, event.clientY);
      const connection = connectionFor(gesture, port);
      const unchanged = Boolean(connection && gesture.edge
        && connection.source === gesture.edge.source
        && connection.target === gesture.edge.target
        && (connection.sourceHandle ?? 'output') === (gesture.edge.sourceHandle ?? 'output')
        && (connection.targetHandle ?? 'input') === (gesture.edge.targetHandle ?? 'input'));
      if (connection && !unchanged) {
        if (gesture.edge) onReconnect(gesture.edge, connection);
        else onConnect(connection);
      } else if (!gesture.edge && gesture.sourceNodeId && !port) {
        const viewport = viewportRef.current;
        const bounds = viewport?.getBoundingClientRect();
        const target = document.elementFromPoint(event.clientX, event.clientY);
        const overBlankCanvas = Boolean(viewport && bounds && target && viewport.contains(target)
          && event.clientX >= bounds.left && event.clientX <= bounds.right
          && event.clientY >= bounds.top && event.clientY <= bounds.bottom
          && !target.closest('[data-flow-node], [data-flow-edge]'));
        if (overBlankCanvas) openNodePicker(gesture.sourceNodeId, event.clientX, event.clientY);
      }
      setGesture(null);
    };
    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
  }, [canvasPoint, connectionFor, gesture, isValidConnection, onConnect, onReconnect, openNodePicker, portAt, viewportRef]);

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
  }, [nodes, selectedNodeId, viewportRef]);

  function handlePortKeyboardStart(nodeId: string, portId: string) {
    setPickerAnchor(null);
    setGesture(null);
    setKeyboardSource({ nodeId, portId });
  }

  function handlePortKeyboardTarget(nodeId: string, portId: string) {
    if (!keyboardSource) return;
    setPickerAnchor(null);
    const connection = { source: keyboardSource.nodeId, sourceHandle: keyboardSource.portId, target: nodeId, targetHandle: portId };
    onConnect(connection);
    setKeyboardSource(null);
  }

  function handleViewportKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      if (pickerAnchor) {
        setPickerAnchor(null);
        return;
      }
      setGesture(null);
      setKeyboardSource(null);
      onClearSelection();
      return;
    }
    if (event.key !== 'Backspace' && event.key !== 'Delete') return;
    const target = event.target as HTMLElement;
    if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    const selectedNode = nodes.find((node) => node.selected);
    const selectedEdge = edges.find((edge) => edge.selected);
    if (!selectedNode && !selectedEdge) return;
    event.preventDefault();
    if (selectedNode) onRemoveNode(selectedNode.id);
    else if (selectedEdge) onRemoveEdge(selectedEdge.id);
  }

  function handleViewportClick(event: ReactMouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('[data-flow-node], [data-flow-edge], [data-flow-port-type]')) return;
    onClearSelection();
  }

  const sourceAnchor = gesture?.sourceNodeId ? portPosition(gesture.sourceNodeId, 'source', gesture.sourcePort) : null;
  const targetAnchor = gesture?.targetNodeId ? portPosition(gesture.targetNodeId, 'target', gesture.targetPort) : null;
  const previewSource = gesture?.side === 'source' ? gesture.pointer : sourceAnchor;
  const previewTarget = gesture?.side === 'target' ? gesture.pointer : gesture?.edge ? targetAnchor : gesture ? gesture.pointer : null;
  const previewPath = previewSource && previewTarget ? edgePath(previewSource, previewTarget) : '';
  const connectionTarget = gesture?.candidate?.type === 'target' ? { nodeId: gesture.candidate.nodeId, portId: gesture.candidate.portId, valid: gesture.candidate.valid } : undefined;
  const connectionSource = gesture?.candidate?.type === 'source' ? { nodeId: gesture.candidate.nodeId, portId: gesture.candidate.portId, valid: gesture.candidate.valid } : undefined;
  const previewClass = gesture?.candidate ? gesture.candidate.valid ? 'workflow-connection-valid' : 'workflow-connection-invalid' : '';

  return (
    <>
      {/* The toolbar factory only runs its callback after a user-activated control event. */}
      {/* eslint-disable-next-line react-hooks/refs */}
      <div className="workflow-flow-toolbar"><div>{toolbar(() => openNodePicker())}</div></div>
      {/* The focusable scroll region owns canvas keyboard shortcuts. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={viewportRef}
        className="workflow-flow-viewport"
        role="region"
        aria-label={t('editor.canvas')}
        tabIndex={0} /* eslint-disable-line jsx-a11y/no-noninteractive-tabindex */
        onKeyDown={handleViewportKeyDown}
        onClick={handleViewportClick}
        onScroll={() => setPickerAnchor(null)}
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
            const labelX = (source.x + target.x) / 2;
            const labelY = feedback ? loopY - 7 : (source.y + target.y) / 2 - 7;
            const labelWidth = edge.label ? Math.max(24, edge.label.length * 6.2 + 12) : 0;
            const sourceName = sourceNode.data.label;
            const targetName = targetNode.data.label;
            const sourceInput = t('editor.outputPort');
            const targetInput = workflowInputs(targetNode).find((input) => input.id === (edge.targetHandle ?? 'input'))?.label ?? t('editor.inputPort');
            return (
              <g
                key={edge.id}
                className={`workflow-flow-edge ${edge.className ?? ''} ${edge.selected ? 'workflow-edge-selected' : ''} ${edge.data?.maxTraversals !== undefined ? 'workflow-edge-bounded' : ''}`}
                data-flow-edge={edge.id}
                role="button"
                tabIndex={0}
                aria-label={`${sourceName} ${sourceInput} → ${targetName} ${targetInput}${edge.label ? `, ${edge.label}` : ''}`}
                onClick={(event) => { event.stopPropagation(); setPickerAnchor(null); onSelectEdge(edge.id); }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    setPickerAnchor(null);
                    onSelectEdge(edge.id);
                  }
                }}
              >
                <path d={path} className="workflow-edge-hit-area" />
                <path d={path} className="workflow-edge-visible" markerEnd={`url(#${markerId})`} />
                {edge.label ? <>
                  <rect className="workflow-edge-label-background" x={labelX - labelWidth / 2} y={labelY - 9} width={labelWidth} height="18" rx="4" />
                  <text className="workflow-edge-label" x={labelX} y={labelY + 1}>{edge.label}</text>
                </> : null}
                {edge.selected ? <>
                  <circle
                    className="workflow-edge-endpoint"
                    cx={source.x}
                    cy={source.y}
                    r="5"
                    aria-label={`${sourceName} ${sourceInput}`}
                    onPointerDown={(event) => beginReconnect(edge, 'source', event)}
                  />
                  <circle
                    className="workflow-edge-endpoint"
                    cx={target.x}
                    cy={target.y}
                    r="5"
                    aria-label={`${targetName} ${targetInput}`}
                    onPointerDown={(event) => beginReconnect(edge, 'target', event)}
                  />
                </> : null}
              </g>
            );
          })}
          {gesture && previewPath ? <path d={previewPath} className={`workflow-connection-preview ${previewClass}`} /> : null}
        </svg>
        {nodes.map((node) => (
          <div key={node.id} className="workflow-flow-node-position" style={{ left: node.position.x, top: node.position.y }}>
            <WorkflowStageNode
              node={node}
              selected={Boolean(node.selected)}
              keyboardSource={keyboardSource?.nodeId === node.id}
              connectionTarget={connectionTarget}
              connectionSource={connectionSource}
              onSelect={(nodeId) => { setPickerAnchor(null); onSelectNode(nodeId); }}
              onStartConnection={beginPointerConnection}
              onKeyboardConnectStart={handlePortKeyboardStart}
              onKeyboardConnectTarget={handlePortKeyboardTarget}
            />
          </div>
        ))}
        </div>
        {nodes.length === 0 ? <div className="workflow-flow-empty">{emptyState}</div> : null}
      </div>
      {pickerAnchor ? (
        <div /* eslint-disable-line jsx-a11y/no-noninteractive-element-interactions */
          ref={pickerRef}
          className="fixed z-[60] flex flex-col overflow-hidden rounded-lg border border-border bg-surface-raised p-3 text-foreground shadow-lg"
          style={{ left: pickerAnchor.left, top: pickerAnchor.top, width: pickerAnchor.width, maxHeight: pickerAnchor.maxHeight }}
          role="dialog"
          aria-label={pickerAnchor.sourceNodeId ? t('editor.connectNode') : t('editor.nodePalette')}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setPickerAnchor(null);
              viewportRef.current?.focus();
            }
          }}
        >
          {renderNodePicker(pickerAnchor.sourceNodeId, (nodeType) => {
            const sourceNodeId = pickerAnchor.sourceNodeId ?? undefined;
            setPickerAnchor(null);
            onAddNode(nodeType, sourceNodeId);
          })}
        </div>
      ) : null}
    </>
  );
}
