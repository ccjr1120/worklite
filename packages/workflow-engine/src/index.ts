import type { WorkflowDefinition, WorkflowEdgeDefinition } from '@worklite/contracts';

export type JsonSchema = Readonly<Record<string, unknown>>;

export type WorkflowPortDefinition = {
  name: string;
  required: boolean;
  dataType: string;
  multiple: boolean;
};

export type WorkflowNodeCapability = {
  id: string;
  version: string;
  name: string;
  purpose: string;
  inputs: WorkflowPortDefinition[];
  outputs: WorkflowPortDefinition[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  configSchema: JsonSchema;
};

export type ArtifactRef = {
  id: string;
  type: string;
  name?: string;
};

export type NodeExecutionContext = {
  workspaceId: string;
  workflowRunId: string;
  workflowVersionId: string;
  nodeId: string;
  nodeRunId: string;
  pendingActionId: string;
  variables: Readonly<Record<string, unknown>>;
};

export type NodeExecutionRequest = {
  input: unknown;
  config: unknown;
  context: NodeExecutionContext;
  signal: AbortSignal;
};

export type CompletedNodeExecutionResult = {
  status?: 'completed';
  output: unknown;
  artifacts?: ArtifactRef[];
};

export type PendingNodeExecutionResult = {
  status: 'waiting_for_input';
  pendingAction: {
    id: string;
    type: 'wechat_login' | 'wechat_publish_confirmation';
    title: string;
    description: string;
    qrCode: string | null;
    expiresAt: Date | null;
    externalOperationId?: string;
  };
};

export type NodeExecutionResult = CompletedNodeExecutionResult | PendingNodeExecutionResult;

export type NodeTypeDefinition = {
  id: string;
  version: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  configSchema: JsonSchema;
  name?: string;
  purpose?: string;
  inputs?: WorkflowPortDefinition[];
  outputs?: WorkflowPortDefinition[];
  execute(request: NodeExecutionRequest): Promise<NodeExecutionResult>;
};

export type WorkflowPlugin = {
  id: string;
  version: string;
  register(registry: NodeTypeRegistry): void | (() => void);
};

export function mountWorkflowPlugin(registry: NodeTypeRegistry, plugin: WorkflowPlugin): () => void {
  return plugin.register(registry) ?? (() => undefined);
}

const WORKLITE_WORKFLOW_NODE_CAPABILITIES: WorkflowNodeCapability[] = [
  {
    id: 'worklite/input',
    version: '1',
    name: 'Workflow Input',
    purpose: 'Expose the Workflow run input.',
    inputs: [],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: { type: 'object' },
    outputSchema: {},
    configSchema: { type: 'object' },
  },
  {
    id: 'worklite/timer',
    version: '1',
    name: 'Timer',
    purpose: 'Trigger Workflow runs at one fixed interval.',
    inputs: [],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    configSchema: {
      type: 'object',
      required: ['enabled', 'intervalSeconds'],
      properties: {
        enabled: { type: 'boolean' },
        intervalSeconds: { type: 'number', minimum: 300 },
      },
    },
  },
  {
    id: 'worklite/dashboard',
    version: '1',
    name: 'Dashboard',
    purpose: 'Publish Workflow output as a Home board.',
    inputs: [{ name: 'data', required: true, dataType: 'json', multiple: false }],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: {},
    outputSchema: {},
    configSchema: {
      type: 'object',
      required: ['layout'],
      properties: {
        layout: {
          type: 'object',
          required: ['header', 'main', 'footer'],
          properties: {
            header: { type: 'array' },
            main: { type: 'array' },
            footer: { type: 'array' },
          },
        },
      },
    },
  },
  {
    id: 'worklite/artifact',
    version: '1',
    name: 'Artifact',
    purpose: 'Persist successful run data as a textual Artifact and expose its reference.',
    inputs: [{ name: 'data', required: true, dataType: 'json', multiple: false }],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: {},
    outputSchema: { type: 'object' },
    configSchema: {
      type: 'object',
      required: ['name', 'type'],
      properties: {
        name: { type: 'string', minLength: 1 },
        type: { type: 'string', enum: ['text', 'markdown', 'json'] },
      },
    },
  },
  {
    id: 'worklite/artifact-query',
    version: '1',
    name: 'Artifact Query',
    purpose: 'Read historical JSON Artifact titles and descriptions from the workspace.',
    inputs: [{ name: 'request', required: true, dataType: 'json', multiple: false }],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: { type: 'object', required: ['request'], properties: { request: {} } },
    outputSchema: { type: 'object', required: ['request', 'candidates'] },
    configSchema: {
      type: 'object',
      required: ['name', 'titleField', 'descriptionFields'],
      properties: {
        name: { type: 'string', minLength: 1 },
        titleField: { type: 'string', minLength: 1 },
        descriptionFields: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      },
    },
  },
  {
    id: 'worklite/approved-article',
    version: '1',
    name: 'Approved Article',
    purpose: 'Extract the original Markdown article only after explicit editorial approval.',
    inputs: [{ name: 'context', required: true, dataType: 'json', multiple: false }],
    outputs: [{ name: 'output', required: false, dataType: 'string', multiple: true }],
    inputSchema: { type: 'object', required: ['context'] },
    outputSchema: { type: 'string' },
    configSchema: { type: 'object' },
  },
  {
    id: 'worklite/image',
    version: '1',
    name: 'Image Generation',
    purpose: 'Generate PNG images from a text prompt.',
    inputs: [{ name: 'prompt', required: true, dataType: 'string', multiple: false }],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } },
    outputSchema: { type: 'object' },
    configSchema: {
      type: 'object',
      required: ['model', 'n', 'background', 'quality', 'size'],
      properties: {
        model: { type: 'string', enum: ['codex/gpt-image-2'] },
        n: { type: 'integer', minimum: 1 },
        background: { type: 'string', enum: ['opaque', 'transparent'] },
        quality: { type: 'string', enum: ['low', 'medium', 'high'] },
        size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536'] },
      },
    },
  },
  {
    id: 'wechat-official-account/publish',
    version: '1',
    name: 'WeChat Official Account',
    purpose: 'Save an article as a WeChat Official Account draft or publish it with human QR confirmation.',
    inputs: [
      { name: 'article', required: true, dataType: 'string', multiple: false },
      { name: 'metadata', required: false, dataType: 'json', multiple: false },
    ],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: { type: 'object', required: ['article'], properties: { article: { type: 'string' }, metadata: { type: 'object' } } },
    outputSchema: { type: 'object' },
    configSchema: {
      type: 'object',
      required: ['accountId', 'mode'],
      properties: {
        accountId: { type: 'string', minLength: 1 },
        mode: { type: 'string', enum: ['draft', 'publish'] },
      },
    },
  },
  {
    id: 'wechat-official-account/publish',
    version: '2',
    name: 'WeChat Official Account',
    purpose: 'Save a Markdown article with a generated PNG cover as a WeChat Official Account draft or publish it with human QR confirmation.',
    inputs: [
      { name: 'article', required: true, dataType: 'string', multiple: false },
      { name: 'metadata', required: false, dataType: 'json', multiple: false },
      { name: 'coverImage', required: true, dataType: 'json', multiple: false },
    ],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: {
      type: 'object',
      required: ['article', 'coverImage'],
      properties: { article: { type: 'string' }, metadata: { type: 'object' }, coverImage: { type: 'object' } },
    },
    outputSchema: { type: 'object' },
    configSchema: {
      type: 'object',
      required: ['accountId', 'mode'],
      properties: {
        accountId: { type: 'string', minLength: 1 },
        mode: { type: 'string', enum: ['draft', 'publish'] },
      },
    },
  },
  {
    id: 'worklite/agent',
    version: '1',
    name: 'Agent',
    purpose: 'Embed a public model id, system prompt, Skill ids, and MCP server ids.',
    inputs: [{ name: 'context', required: false, dataType: 'json', multiple: false }],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: { type: 'object' },
    outputSchema: {},
    configSchema: { type: 'object', required: ['model', 'systemPrompt', 'skillIds', 'mcpServerIds'], properties: { model: { type: 'string' }, systemPrompt: { type: 'string' }, outputFormat: { type: 'string', enum: ['text', 'json'] }, outputContract: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }, passthroughKeys: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }, maxToolCalls: { type: 'integer', minimum: 1 }, maxToolRounds: { type: 'integer', minimum: 1 }, maxToolResultChars: { type: 'integer', minimum: 1 }, skillIds: { type: 'array', items: { type: 'string' } }, mcpServerIds: { type: 'array', items: { type: 'string' } } } },
  },
  {
    id: 'worklite/branch',
    version: '1',
    name: 'Choice Branch',
    purpose: 'Pass through a JSON value and select the first matching outgoing route.',
    inputs: [{ name: 'value', required: true, dataType: 'json', multiple: false }],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: { type: 'object', required: ['value'] },
    outputSchema: {},
    configSchema: { type: 'object' },
  },
  {
    id: 'typesafe/systemone-map',
    version: '1',
    name: 'TypeSafe System One Map',
    purpose: 'Evaluate one typed question set against every element of an array inside the Workflow state, then rank the evaluated elements.',
    inputs: [{ name: 'state', required: true, dataType: 'json', multiple: false }],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: { type: 'object', required: ['state'], properties: { state: {} } },
    outputSchema: { type: 'object', required: ['results'] },
    configSchema: {
      type: 'object',
      required: ['model', 'questions', 'itemsPath'],
      properties: {
        model: { type: 'string' },
        questions: { type: 'object' },
        itemsPath: { type: 'string', minLength: 1 },
        contextPath: { type: 'string', minLength: 1 },
        concurrency: { type: 'integer', minimum: 1 },
        rank: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', minLength: 1 },
            order: { type: 'string', enum: ['asc', 'desc'] },
            limit: { type: 'integer', minimum: 1 },
            minimum: { type: 'number' },
          },
        },
      },
    },
  },
  {
    id: 'typesafe/systemone',
    version: '1',
    name: 'TypeSafe System One',
    purpose: 'Forward typed Workflow state and questions to a TypeSafe System One Provider while retaining JSON state fields for downstream routing.',
    inputs: [{ name: 'state', required: true, dataType: 'json', multiple: false }],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: { type: 'object', required: ['state'], properties: { state: {} } },
    outputSchema: { type: 'object', required: ['answers'] },
    configSchema: {
      type: 'object',
      required: ['model', 'questions'],
      properties: {
        model: { type: 'string' },
        questions: { type: 'object' },
      },
    },
  },
];

export function listWorkflowNodeCapabilities(): WorkflowNodeCapability[] {
  return WORKLITE_WORKFLOW_NODE_CAPABILITIES.map((capability) => ({
    ...capability,
    inputs: capability.inputs.map((port) => ({ ...port })),
    outputs: capability.outputs.map((port) => ({ ...port })),
  }));
}

export function resolveWorkflowNodeCapability(id: string, version: string): WorkflowNodeCapability | undefined {
  return WORKLITE_WORKFLOW_NODE_CAPABILITIES.find((capability) => capability.id === id && capability.version === version);
}

export class NodeTypeRegistry {
  private readonly definitions = new Map<string, NodeTypeDefinition>();

  register(definition: NodeTypeDefinition): () => void {
    const key = this.key(definition.id, definition.version);
    if (this.definitions.has(key)) throw new Error(`Node Type already registered: ${key}`);
    this.definitions.set(key, definition);
    return () => {
      if (this.definitions.get(key) === definition) this.definitions.delete(key);
    };
  }

  resolve(id: string, version: string): NodeTypeDefinition {
    const definition = this.definitions.get(this.key(id, version));
    if (!definition) throw new Error(`Node Type is not registered: ${id}@${version}`);
    return definition;
  }

  list(): NodeTypeDefinition[] {
    return [...this.definitions.values()].sort((left, right) => this.key(left.id, left.version).localeCompare(this.key(right.id, right.version)));
  }

  private key(id: string, version: string): string {
    return `${id}@${version}`;
  }
}

export type WorkflowScheduledInvocation = {
  nodeId: string;
  input: Record<string, unknown>;
};

export type WorkflowActiveInvocation = WorkflowScheduledInvocation & {
  nodeRunId: string;
  position: number;
};

export type WorkflowSchedulerState = {
  ready: WorkflowScheduledInvocation[];
  pendingInputs: Record<string, Record<string, unknown[]>>;
  edgeTraversals: Record<string, number>;
  latestOutputs: Record<string, unknown>;
  terminalOutputs: Record<string, unknown>;
  nextPosition: number;
  active?: WorkflowActiveInvocation;
};

const VALUE_COMPARISON_OPERATORS = new Set([
  'equals',
  'notEquals',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
]);

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) return false;
  const leftEntries = Object.entries(left);
  const rightRecord = right as Record<string, unknown>;
  return leftEntries.length === Object.keys(rightRecord).length && leftEntries.every(([key, value]) => Object.hasOwn(rightRecord, key) && deepEqual(value, rightRecord[key]));
}

type WorkflowOrderedComparisonOperator = 'greaterThan' | 'greaterThanOrEqual' | 'lessThan' | 'lessThanOrEqual';

function compareWorkflowOrderedValues(left: unknown, right: unknown, operator: WorkflowOrderedComparisonOperator): boolean {
  if (typeof left === 'number' && typeof right === 'number') {
    if (operator === 'greaterThan') return left > right;
    if (operator === 'greaterThanOrEqual') return left >= right;
    if (operator === 'lessThan') return left < right;
    return left <= right;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    if (operator === 'greaterThan') return left > right;
    if (operator === 'greaterThanOrEqual') return left >= right;
    if (operator === 'lessThan') return left < right;
    return left <= right;
  }
  return false;
}

export function readWorkflowOutputPath(output: unknown, path: string): { exists: boolean; value: unknown } {
  const normalized = path.trim().replace(/^\$\.?/, '');
  if (!normalized) return { exists: true, value: output };
  let current = output;
  for (const segment of normalized.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      const index = Number(segment);
      if (index >= current.length) return { exists: false, value: undefined };
      current = current[index];
      continue;
    }
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) return { exists: false, value: undefined };
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
}

export function evaluateWorkflowEdgeCondition(edge: WorkflowEdgeDefinition, output: unknown): boolean {
  if (!edge.condition) return true;
  if (edge.condition.kind === 'fallback') return false;
  const resolved = readWorkflowOutputPath(output, edge.condition.path);
  switch (edge.condition.operator) {
    case 'exists':
      return resolved.exists;
    case 'notExists':
      return !resolved.exists;
    case 'truthy':
      return Boolean(resolved.value);
    case 'falsy':
      return !resolved.value;
    case 'equals':
      return deepEqual(resolved.value, edge.condition.value);
    case 'notEquals':
      return !deepEqual(resolved.value, edge.condition.value);
    case 'greaterThan':
      return compareWorkflowOrderedValues(resolved.value, edge.condition.value, 'greaterThan');
    case 'greaterThanOrEqual':
      return compareWorkflowOrderedValues(resolved.value, edge.condition.value, 'greaterThanOrEqual');
    case 'lessThan':
      return compareWorkflowOrderedValues(resolved.value, edge.condition.value, 'lessThan');
    case 'lessThanOrEqual':
      return compareWorkflowOrderedValues(resolved.value, edge.condition.value, 'lessThanOrEqual');
  }
}

export function validateWorkflowControlFlow(definition: WorkflowDefinition): void {
  const nodesById = new Set(definition.nodes.map((node) => node.id));
  const incoming = new Map(definition.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(definition.nodes.map((node) => [node.id, [] as string[]]));

  for (const edge of definition.edges) {
    if (!nodesById.has(edge.sourceNodeId) || !nodesById.has(edge.targetNodeId)) throw new Error('Workflow edge references an unavailable node.');
    if (edge.maxTraversals !== undefined) continue;
    incoming.set(edge.targetNodeId, (incoming.get(edge.targetNodeId) ?? 0) + 1);
    outgoing.get(edge.sourceNodeId)?.push(edge.targetNodeId);
  }

  const ready = definition.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  while (ready.length > 0) {
    const nodeId = ready.shift();
    if (!nodeId) break;
    visited += 1;
    for (const targetId of outgoing.get(nodeId) ?? []) {
      const remaining = (incoming.get(targetId) ?? 0) - 1;
      incoming.set(targetId, remaining);
      if (remaining === 0) ready.push(targetId);
    }
  }

  if (visited !== definition.nodes.length) throw new Error('Every workflow cycle must cross an edge with a maximum traversal count.');
}

function connectedInputPorts(definition: WorkflowDefinition, nodeId: string): Set<string> {
  return new Set(definition.edges.filter((edge) => edge.targetNodeId === nodeId).map((edge) => edge.targetPort));
}

function takeReadyInput(definition: WorkflowDefinition, state: WorkflowSchedulerState, nodeId: string): Record<string, unknown> | undefined {
  const node = definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return undefined;
  const capability = resolveWorkflowNodeCapability(node.type, node.typeVersion);
  if (!capability) throw new Error(`Node Type is not registered: ${node.type}@${node.typeVersion}`);
  const connected = connectedInputPorts(definition, nodeId);
  const pending = state.pendingInputs[nodeId] ?? {};
  const connectedPorts = capability.inputs.filter((port) => connected.has(port.name));
  const requiredPorts = connectedPorts.filter((port) => port.required);
  if (requiredPorts.some((port) => (pending[port.name]?.length ?? 0) === 0)) return undefined;
  if (connectedPorts.length > 0 && requiredPorts.length === 0 && connectedPorts.every((port) => (pending[port.name]?.length ?? 0) === 0)) return undefined;

  const input: Record<string, unknown> = {};
  for (const port of connectedPorts) {
    const values = pending[port.name] ?? [];
    if (values.length === 0) continue;
    input[port.name] = port.multiple ? values.splice(0) : values.shift();
  }
  return input;
}

function enqueueReadyInvocations(definition: WorkflowDefinition, state: WorkflowSchedulerState, candidateNodeIds: ReadonlySet<string>): void {
  for (const node of definition.nodes) {
    if (!candidateNodeIds.has(node.id)) continue;
    while (true) {
      const input = takeReadyInput(definition, state, node.id);
      if (!input) break;
      state.ready.push({ nodeId: node.id, input });
    }
  }
}

export function createWorkflowSchedulerState(definition: WorkflowDefinition): WorkflowSchedulerState {
  const nodesWithUnboundedIncomingEdges = new Set(definition.edges.filter((edge) => edge.maxTraversals === undefined).map((edge) => edge.targetNodeId));
  const nodesWithConnectedRequiredInputs = new Set(definition.nodes.flatMap((node) => {
    const capability = resolveWorkflowNodeCapability(node.type, node.typeVersion);
    if (!capability) throw new Error(`Node Type is not registered: ${node.type}@${node.typeVersion}`);
    const connected = connectedInputPorts(definition, node.id);
    return capability.inputs.some((port) => port.required && connected.has(port.name)) ? [node.id] : [];
  }));
  return {
    ready: definition.nodes.filter((node) => !nodesWithUnboundedIncomingEdges.has(node.id) && !nodesWithConnectedRequiredInputs.has(node.id)).map((node) => ({ nodeId: node.id, input: {} })),
    pendingInputs: {},
    edgeTraversals: {},
    latestOutputs: {},
    terminalOutputs: {},
    nextPosition: 0,
  };
}

export function takeNextWorkflowInvocation(state: WorkflowSchedulerState): WorkflowScheduledInvocation | undefined {
  return state.ready.shift();
}

export function selectWorkflowEdges(definition: WorkflowDefinition, state: WorkflowSchedulerState, nodeId: string, output: unknown): WorkflowEdgeDefinition[] {
  const available = definition.edges.filter((edge) => edge.sourceNodeId === nodeId && (edge.maxTraversals === undefined || (state.edgeTraversals[edge.id] ?? 0) < edge.maxTraversals));
  const matched = available.filter((edge) => edge.condition?.kind !== 'fallback' && evaluateWorkflowEdgeCondition(edge, output));
  const exclusive = definition.nodes.find((node) => node.id === nodeId)?.type === 'worklite/branch';
  if (matched.length > 0) return exclusive ? matched.slice(0, 1) : matched;
  const fallback = available.filter((edge) => edge.condition?.kind === 'fallback');
  return exclusive ? fallback.slice(0, 1) : fallback;
}

export function commitWorkflowInvocation(definition: WorkflowDefinition, state: WorkflowSchedulerState, nodeId: string, output: unknown): WorkflowEdgeDefinition[] {
  const normalizedOutput = output === undefined ? null : output;
  const traversedEdges = selectWorkflowEdges(definition, state, nodeId, normalizedOutput);
  state.latestOutputs[nodeId] = normalizedOutput;
  if (traversedEdges.length === 0) state.terminalOutputs[nodeId] = normalizedOutput;
  else delete state.terminalOutputs[nodeId];

  const candidateNodeIds = new Set<string>();
  for (const edge of traversedEdges) {
    state.edgeTraversals[edge.id] = (state.edgeTraversals[edge.id] ?? 0) + 1;
    const nodeInputs = state.pendingInputs[edge.targetNodeId] ?? {};
    const values = nodeInputs[edge.targetPort] ?? [];
    values.push(normalizedOutput);
    nodeInputs[edge.targetPort] = values;
    state.pendingInputs[edge.targetNodeId] = nodeInputs;
    candidateNodeIds.add(edge.targetNodeId);
  }
  enqueueReadyInvocations(definition, state, candidateNodeIds);
  return traversedEdges;
}

export function workflowRunResult(state: WorkflowSchedulerState): Record<string, unknown> {
  return { ...state.terminalOutputs };
}

export function workflowEdgeRequiresComparisonValue(operator: string): boolean {
  return VALUE_COMPARISON_OPERATORS.has(operator);
}

export type GenericAgentNodeConfig = {
  agentVersionId: string;
  outputSchema?: JsonSchema;
};

export type GenericAgentNodeExecutionRequest = NodeExecutionRequest & {
  config: GenericAgentNodeConfig;
};

export type GenericAgentNodeExecutor = (request: GenericAgentNodeExecutionRequest) => Promise<NodeExecutionResult>;

export function createGenericAgentNodeType(execute: GenericAgentNodeExecutor): NodeTypeDefinition {
  return {
    id: 'worklite/generic-agent',
    version: '1',
    inputSchema: {
      type: 'object',
      required: ['context', 'systemPrompt'],
      properties: {
        context: {},
        systemPrompt: { type: 'string' },
        skills: { type: 'object' },
      },
    },
    outputSchema: {},
    configSchema: {
      type: 'object',
      required: ['agentVersionId'],
      properties: {
        agentVersionId: { type: 'string' },
        outputSchema: { type: 'object' },
      },
    },
    execute,
  };
}
