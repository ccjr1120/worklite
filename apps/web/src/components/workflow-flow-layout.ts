import type { WorkflowCanvasEdge, WorkflowCanvasNode } from './workflow-canvas-nodes';

export function calculateWorkflowFlowLayout(nodes: WorkflowCanvasNode[], edges: WorkflowCanvasEdge[]): Map<string, { x: number; y: number }> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const rank = new Map(nodes.map((node) => [node.id, 0]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const successors = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const graphEdges = edges.filter((edge) => nodeById.has(edge.source) && nodeById.has(edge.target));
  const feedbackEdgeIds = new Set(graphEdges
    .filter((edge) => edge.data?.maxTraversals !== undefined)
    .filter((edge) => isReachable(edge.target, edge.source, graphEdges.filter((candidate) => candidate.id !== edge.id)))
    .map((edge) => edge.id));
  const forwardEdges = graphEdges.filter((edge) => !feedbackEdgeIds.has(edge.id));

  for (const edge of forwardEdges) {
    successors.get(edge.source)?.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  const byDefinitionOrder = (leftId: string, rightId: string) => (nodeOrder.get(leftId) ?? 0) - (nodeOrder.get(rightId) ?? 0);
  const ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id).sort(byDefinitionOrder);
  const order: string[] = [];

  while (ready.length > 0) {
    const nodeId = ready.shift()!;
    order.push(nodeId);
    for (const targetId of successors.get(nodeId) ?? []) {
      rank.set(targetId, Math.max(rank.get(targetId) ?? 0, (rank.get(nodeId) ?? 0) + 1));
      const remaining = (indegree.get(targetId) ?? 0) - 1;
      indegree.set(targetId, remaining);
      if (remaining === 0) {
        ready.push(targetId);
        ready.sort(byDefinitionOrder);
      }
    }
  }

  for (const node of nodes) {
    if (!order.includes(node.id)) {
      rank.set(node.id, Math.max(-1, ...rank.values()) + 1);
      order.push(node.id);
    }
  }

  const orderIndex = new Map(order.map((nodeId, index) => [nodeId, index]));
  const columns = new Map<number, string[]>();
  for (const nodeId of order) {
    const column = rank.get(nodeId) ?? 0;
    columns.set(column, [...(columns.get(column) ?? []), nodeId]);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const orderedColumns = [...columns.entries()].sort(([left], [right]) => left - right);
  const laneSpacing = 160;
  const minimumYOffset = Math.min(0, ...orderedColumns.map(([, columnNodeIds]) => -((columnNodeIds.length - 1) / 2) * laneSpacing));
  for (const [columnRank, columnNodeIds] of orderedColumns) {
    const incomingSources = new Map(columnNodeIds.map((nodeId) => [
      nodeId,
      forwardEdges.filter((edge) => edge.target === nodeId).map((edge) => orderIndex.get(edge.source) ?? 0),
    ]));
    columnNodeIds.sort((leftId, rightId) => {
      const leftSources = incomingSources.get(leftId) ?? [];
      const rightSources = incomingSources.get(rightId) ?? [];
      const leftCenter = leftSources.length ? leftSources.reduce((sum, value) => sum + value, 0) / leftSources.length : orderIndex.get(leftId) ?? 0;
      const rightCenter = rightSources.length ? rightSources.reduce((sum, value) => sum + value, 0) / rightSources.length : orderIndex.get(rightId) ?? 0;
      return leftCenter - rightCenter || byDefinitionOrder(leftId, rightId);
    });
    columnNodeIds.forEach((nodeId, index) => {
      positions.set(nodeId, {
        x: 48 + columnRank * 340,
        y: 48 + (index - (columnNodeIds.length - 1) / 2) * laneSpacing - minimumYOffset,
      });
    });
  }
  return positions;
}

function isReachable(startNodeId: string, targetNodeId: string, edges: WorkflowCanvasEdge[]): boolean {
  const pending = [startNodeId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!nodeId || visited.has(nodeId)) continue;
    if (nodeId === targetNodeId) return true;
    visited.add(nodeId);
    for (const edge of edges) if (edge.source === nodeId) pending.push(edge.target);
  }
  return false;
}
