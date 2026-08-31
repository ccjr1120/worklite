import type { WorkflowDefinition, WorkflowEdgeDefinition, WorkflowNodeDefinition } from '@worklite/contracts';

export type JsonSchema = Readonly<Record<string, unknown>>;

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
  variables: Readonly<Record<string, unknown>>;
};

export type NodeExecutionRequest = {
  input: unknown;
  config: unknown;
  context: NodeExecutionContext;
  signal: AbortSignal;
};

export type NodeExecutionResult = {
  output: unknown;
  artifacts?: ArtifactRef[];
};

export type NodeTypeDefinition = {
  id: string;
  version: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  configSchema: JsonSchema;
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

export function topologicallySortWorkflow(definition: WorkflowDefinition): WorkflowNodeDefinition[] {
  const order = new Map(definition.nodes.map((node, index) => [node.id, index]));
  const nodesById = new Map(definition.nodes.map((node) => [node.id, node]));
  const incoming = new Map(definition.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(definition.nodes.map((node) => [node.id, [] as string[]]));

  for (const edge of definition.edges) {
    if (!nodesById.has(edge.sourceNodeId) || !nodesById.has(edge.targetNodeId)) throw new Error('Workflow edge references an unavailable node.');
    incoming.set(edge.targetNodeId, (incoming.get(edge.targetNodeId) ?? 0) + 1);
    outgoing.get(edge.sourceNodeId)?.push(edge.targetNodeId);
  }

  const ready = definition.nodes.filter((node) => incoming.get(node.id) === 0);
  const result: WorkflowNodeDefinition[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
    const node = ready.shift();
    if (!node) break;
    result.push(node);
    for (const targetId of outgoing.get(node.id) ?? []) {
      const remaining = (incoming.get(targetId) ?? 0) - 1;
      incoming.set(targetId, remaining);
      if (remaining === 0) {
        const target = nodesById.get(targetId);
        if (target) ready.push(target);
      }
    }
  }

  if (result.length !== definition.nodes.length) throw new Error('Workflow graph must not contain a cycle.');
  return result;
}

export function collectNodeInputs(edges: WorkflowEdgeDefinition[], nodeId: string, outputs: ReadonlyMap<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    edges
      .filter((edge) => edge.targetNodeId === nodeId)
      .map((edge) => [edge.targetPort, outputs.get(edge.sourceNodeId)]),
  );
}

export function getLeafNodeIds(definition: WorkflowDefinition): string[] {
  const sourceIds = new Set(definition.edges.map((edge) => edge.sourceNodeId));
  return definition.nodes.filter((node) => !sourceIds.has(node.id)).map((node) => node.id);
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
