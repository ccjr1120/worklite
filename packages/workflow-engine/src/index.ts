import type { NodeErrorPolicy } from '@worklite/contracts';

export type JsonSchema = Readonly<Record<string, unknown>>;

export type ArtifactRef = {
  id: string;
  type: string;
  name?: string;
};

export type NodeInputMapping =
  | { source: 'workflow.input' }
  | { source: 'previous.output' }
  | { source: 'literal'; value: unknown };

export type WorkflowNodeDefinition = {
  id: string;
  position: number;
  type: string;
  typeVersion: string;
  config: unknown;
  input: NodeInputMapping;
  errorPolicy: NodeErrorPolicy;
};

export type WorkflowDefinition = {
  schemaVersion: number;
  nodes: WorkflowNodeDefinition[];
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

export function sortNodes(nodes: WorkflowNodeDefinition[]): WorkflowNodeDefinition[] {
  return [...nodes].sort((left, right) => left.position - right.position);
}

export function resolveLinearInput(node: WorkflowNodeDefinition, workflowInput: unknown, previousOutput: unknown): unknown {
  switch (node.input.source) {
    case 'workflow.input':
      return workflowInput;
    case 'previous.output':
      return previousOutput;
    case 'literal':
      return node.input.value;
  }
}

export type AgentNodeConfig = {
  agentVersionId: string;
  promptTemplate?: string;
  outputSchema?: JsonSchema;
};

export type AgentNodeExecutionRequest = NodeExecutionRequest & {
  config: AgentNodeConfig;
};

export type AgentNodeExecutor = (request: AgentNodeExecutionRequest) => Promise<NodeExecutionResult>;

export function createAgentNodeType(execute: AgentNodeExecutor): NodeTypeDefinition {
  return {
    id: 'worklite/agent',
    version: '1',
    inputSchema: {},
    outputSchema: {},
    configSchema: {
      type: 'object',
      required: ['agentVersionId'],
      properties: {
        agentVersionId: { type: 'string' },
        promptTemplate: { type: 'string' },
        outputSchema: { type: 'object' },
      },
    },
    execute,
  };
}
