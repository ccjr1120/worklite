import {
  workflowRerunAffectedNodeIds,
  type WorkflowDefinition,
  type WorkflowEdgeDefinition,
  type WorkflowNodeDefinition,
} from '@worklite/contracts';

export type JsonSchema = Readonly<Record<string, unknown>>;

// Every node may carry a short display label and a one-sentence description so
// editors and run views can show what a step does instead of only its type name.
export const WORKFLOW_NODE_LABEL_MAX_LENGTH = 40;
export const WORKFLOW_NODE_DESCRIPTION_MAX_LENGTH = 200;

function withNodeIdentity(schema: JsonSchema): JsonSchema {
  const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {};
  return {
    ...schema,
    properties: {
      label: { type: 'string', minLength: 1, maxLength: WORKFLOW_NODE_LABEL_MAX_LENGTH },
      description: { type: 'string', minLength: 1, maxLength: WORKFLOW_NODE_DESCRIPTION_MAX_LENGTH },
      ...properties,
    },
  };
}

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
  /**
   * A join node does not consume one FIFO queue per port. The scheduler holds
   * one value per incoming edge and only fires once every eligible edge has a
   * value, then emits those values as one ordered array.
   */
  aggregation?: 'join';
};

export type ArtifactRef = {
  id: string;
  format: string;
  name?: string;
};

export type NodeExecutionContext = {
  workspaceId: string;
  // The Workflow a node belongs to, so usage recorded against this node survives the
  // Run that produced it: Gateway statistics outlive Run records.
  workflowId: string;
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

const WORKFLOW_NODE_CAPABILITIES: WorkflowNodeCapability[] = [
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
    purpose: 'Persist successful run data as Artifacts with a format inferred from the input or explicitly overridden.',
    inputs: [{ name: 'data', required: true, dataType: 'json', multiple: false }],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: {},
    outputSchema: { type: 'object' },
    configSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
        format: { type: 'string', enum: ['text', 'markdown', 'json', 'image'], description: 'Optional format override; omitted formats are inferred from the input.' },
        placement: { type: 'string', enum: ['inline', 'asset'], description: 'Optional image placement metadata; inline images can resolve Markdown image placeholders.' },
        type: { type: 'string', enum: ['text', 'markdown', 'json', 'image'], deprecated: true, description: 'Legacy format override retained for existing workflow versions.' },
        imageRole: { type: 'string', enum: ['inline', 'asset'], deprecated: true, description: 'Legacy image placement field retained for existing workflow versions.' },
      },
    },
  },
  {
    id: 'worklite/local-project-search',
    version: '1',
    name: 'Local Project Search',
    purpose: 'Resolve local project names through the metadata-only index and verify candidate directories. No match means not indexed, never proof of nonexistence.',
    inputs: [{ name: 'query', required: true, dataType: 'string', multiple: false }],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: false }],
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 50 }, refresh: { type: 'boolean' } }, additionalProperties: false },
    outputSchema: { type: 'object' },
    configSchema: { type: 'object', additionalProperties: false },
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
    inputs: [
      { name: 'prompt', required: false, dataType: 'string', multiple: false },
      { name: 'context', required: false, dataType: 'json', multiple: false },
    ],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, context: {} } },
    outputSchema: {
      type: 'object',
      required: ['type', 'model', 'mediaType', 'data'],
      properties: {
        type: { type: 'string', enum: ['workflow_image'] },
        model: { type: 'string' },
        mediaType: { type: 'string', enum: ['image/png'] },
        key: { type: 'string' },
        data: { type: 'array', items: { type: 'object', required: ['b64Json'], properties: { b64Json: { type: 'string' } } } },
      },
    },
    configSchema: {
      type: 'object',
      required: ['model', 'n', 'background', 'quality', 'size'],
      properties: {
        model: { type: 'string', enum: ['codex/gpt-image-2'] },
        n: { type: 'integer', minimum: 1 },
        background: { type: 'string', enum: ['opaque', 'transparent'] },
        quality: { type: 'string', enum: ['low', 'medium', 'high'] },
        size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536'] },
        key: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
        promptPath: { type: 'string', minLength: 1 },
      },
    },
  },
  {
    id: 'worklite/canvas-sticker',
    version: '1',
    name: 'Canvas Sticker',
    purpose: 'Draw a deterministic PNG sticker from a configured shape and optional text using the Canvas 2D API.',
    inputs: [{ name: 'text', required: false, dataType: 'string', multiple: false }],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    outputSchema: {
      type: 'object',
      required: ['type', 'model', 'mediaType', 'data'],
      properties: {
        type: { type: 'string', enum: ['workflow_image'] },
        model: { type: 'string' },
        mediaType: { type: 'string', enum: ['image/png'] },
        key: { type: 'string' },
        data: { type: 'array', items: { type: 'object', required: ['b64Json'], properties: { b64Json: { type: 'string' } } } },
      },
    },
    configSchema: {
      type: 'object',
      required: ['width', 'height', 'shape', 'backgroundColor'],
      properties: {
        width: { type: 'integer', minimum: 64, maximum: 2048 },
        height: { type: 'integer', minimum: 64, maximum: 2048 },
        shape: { type: 'string', enum: ['none', 'roundedRect', 'circle', 'ribbon'] },
        backgroundColor: { type: 'string' },
        key: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
        cornerRadius: { type: 'integer', minimum: 0 },
        text: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            color: { type: 'string' },
            fontSize: { type: 'integer', minimum: 8, maximum: 400 },
            fontFamily: { type: 'string', enum: ['sans-serif', 'serif', 'monospace'] },
            align: { type: 'string', enum: ['left', 'center', 'right'] },
          },
        },
      },
    },
  },
  {
    id: 'worklite/canvas-render',
    version: '1',
    name: 'Canvas Render',
    purpose: 'Run an Agent-authored Canvas 2D script and produce a deterministic PNG image.',
    inputs: [{ name: 'code', required: true, dataType: 'string', multiple: false }],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: { type: 'object', required: ['code'], properties: { code: { type: 'string', minLength: 1, maxLength: 65536 } } },
    outputSchema: {
      type: 'object',
      required: ['type', 'model', 'mediaType', 'width', 'height', 'data'],
      properties: {
        type: { type: 'string', enum: ['workflow_image'] },
        model: { type: 'string' },
        mediaType: { type: 'string', enum: ['image/png'] },
        width: { type: 'integer' },
        height: { type: 'integer' },
        key: { type: 'string' },
        data: { type: 'array', items: { type: 'object', required: ['b64Json'], properties: { b64Json: { type: 'string' } } } },
      },
    },
    configSchema: {
      type: 'object',
      required: ['width', 'height'],
      properties: {
        width: { type: 'integer', minimum: 16, maximum: 4096 },
        height: { type: 'integer', minimum: 16, maximum: 4096 },
        backgroundColor: { type: 'string' },
        key: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
        timeoutMs: { type: 'integer', minimum: 100, maximum: 60000 },
        maxOutputBytes: { type: 'integer', minimum: 1024, maximum: 33554432 },
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
    purpose: 'Save a Markdown article with a generated PNG cover and optional inline images as a WeChat Official Account draft or publish it with human QR confirmation.',
    inputs: [
      { name: 'article', required: true, dataType: 'string', multiple: false },
      { name: 'metadata', required: false, dataType: 'json', multiple: false },
      { name: 'coverImage', required: true, dataType: 'json', multiple: false },
      { name: 'images', required: false, dataType: 'json', multiple: true },
    ],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: {
      type: 'object',
      required: ['article', 'coverImage'],
      properties: { article: { type: 'string' }, metadata: { type: 'object' }, coverImage: { type: 'object' }, images: { type: 'array', items: { type: 'object' } } },
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
    // model accepts one public provider/model id or an ordered list of fallback candidates; the
    // generic property validator only enforces a plain 'string' or 'array' type keyword, so this
    // union is left untyped here and validated precisely by the API's node-specific config check.
    configSchema: { type: 'object', required: ['model', 'systemPrompt', 'skillIds', 'mcpServerIds'], properties: { model: {}, systemPrompt: { type: 'string' }, outputFormat: { type: 'string', enum: ['text', 'json'] }, outputContract: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }, passthroughKeys: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }, allowEmptyOutputKeys: { type: 'array', items: { type: 'string', minLength: 1 } }, maxToolCalls: { type: 'integer', minimum: 1 }, maxToolRounds: { type: 'integer', minimum: 1 }, maxToolResultChars: { type: 'integer', minimum: 1 }, maxOutputTokens: { type: 'integer', minimum: 1024, maximum: 128000 }, skillIds: { type: 'array', items: { type: 'string' } }, requiredSkillIds: { type: 'array', items: { type: 'string', minLength: 1 } }, mcpServerIds: { type: 'array', items: { type: 'string' } } } },
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
  {
    id: 'worklite/map',
    version: '1',
    name: 'Array Map',
    purpose: 'Run an inline subgraph once for every element of a JSON array and return the results in item order.',
    inputs: [
      { name: 'items', required: true, dataType: 'json', multiple: false },
      { name: 'context', required: false, dataType: 'json', multiple: false },
    ],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: {
      type: 'object',
      required: ['items'],
      properties: { items: {}, context: {} },
    },
    outputSchema: { type: 'array' },
    configSchema: {
      type: 'object',
      required: ['subgraph'],
      properties: {
        itemsPath: { type: 'string' },
        subgraph: {
          type: 'object',
          required: ['nodes', 'edges'],
          properties: { nodes: { type: 'array' }, edges: { type: 'array' } },
        },
        bindings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['nodeId', 'field', 'path'],
            properties: {
              nodeId: { type: 'string', minLength: 1 },
              field: { type: 'string', minLength: 1 },
              path: { type: 'string', minLength: 1 },
            },
          },
        },
        outputNodeId: { type: 'string', minLength: 1 },
        entryPort: { type: 'string', minLength: 1 },
        continueOnError: { type: 'boolean' },
        maxItems: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    id: 'worklite/join',
    version: '1',
    name: 'Join Barrier',
    purpose: 'Wait for every sibling branch and emit their outputs as one ordered JSON array.',
    inputs: [{ name: 'input', required: true, dataType: 'json', multiple: true }],
    outputs: [{ name: 'output', required: false, dataType: 'json', multiple: true }],
    inputSchema: { type: 'object', required: ['input'], properties: { input: { type: 'array' } } },
    outputSchema: { type: 'array' },
    configSchema: {
      type: 'object',
      properties: {
        orderBy: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', minLength: 1 },
            direction: { type: 'string', enum: ['asc', 'desc'] },
          },
        },
      },
    },
    aggregation: 'join',
  },
  {
    id: 'worklite/compose-article',
    version: '1',
    name: 'Compose Article',
    purpose: 'Resolve inline image placeholders into generated images and enforce deterministic article invariants.',
    inputs: [
      { name: 'article', required: true, dataType: 'json', multiple: false },
      { name: 'images', required: true, dataType: 'json', multiple: false },
      { name: 'coverImage', required: true, dataType: 'json', multiple: false },
    ],
    outputs: [{ name: 'output', required: false, dataType: 'string', multiple: true }],
    inputSchema: {
      type: 'object',
      required: ['article', 'images', 'coverImage'],
      properties: { article: {}, images: { type: 'array' }, coverImage: { type: 'object' } },
    },
    outputSchema: { type: 'string' },
    configSchema: {
      type: 'object',
      properties: {
        titlePath: { type: 'string', minLength: 1 },
        articlePath: { type: 'string', minLength: 1 },
        unusedImagePolicy: { type: 'string', enum: ['drop', 'append'] },
      },
    },
  },
];

const WORKLITE_WORKFLOW_NODE_CAPABILITIES: WorkflowNodeCapability[] = WORKFLOW_NODE_CAPABILITIES.map((capability) => ({
  ...capability,
  configSchema: withNodeIdentity(capability.configSchema),
}));

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
  /**
   * Join nodes buffer one queue per incoming edge, keyed by edge id, so
   * sibling outputs can be ordered deterministically by definition edge order.
   */
  joinBuffers?: Record<string, Record<string, unknown[]>>;
  edgeTraversals: Record<string, number>;
  latestOutputs: Record<string, unknown>;
  terminalOutputs: Record<string, unknown>;
  nextPosition: number;
  active?: WorkflowActiveInvocation;
};

export type WorkflowRerunHistoryEntry = {
  nodeId: string;
  input: unknown;
  position: number;
  status: string;
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

function orderJoinValues(values: unknown[], config: unknown): unknown[] {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return values;
  const orderBy = (config as Record<string, unknown>).orderBy;
  if (!orderBy || typeof orderBy !== 'object' || Array.isArray(orderBy)) return values;
  const path = (orderBy as Record<string, unknown>).path;
  if (typeof path !== 'string' || !path.trim()) return values;
  const direction = (orderBy as Record<string, unknown>).direction === 'desc' ? -1 : 1;
  return values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => {
      const leftValue = readWorkflowOutputPath(left.value, path);
      const rightValue = readWorkflowOutputPath(right.value, path);
      const leftKey = leftValue.exists ? leftValue.value : undefined;
      const rightKey = rightValue.exists ? rightValue.value : undefined;
      let comparison = 0;
      if (typeof leftKey === 'number' && typeof rightKey === 'number') comparison = leftKey - rightKey;
      else if (typeof leftKey === 'string' && typeof rightKey === 'string') comparison = leftKey.localeCompare(rightKey);
      else if (leftKey === undefined || leftKey === null) comparison = rightKey === undefined || rightKey === null ? 0 : 1;
      else comparison = rightKey === undefined || rightKey === null ? -1 : 0;
      if (comparison === 0) return left.index - right.index;
      return comparison * direction;
    })
    .map((entry) => entry.value);
}

function takeReadyJoinInput(definition: WorkflowDefinition, state: WorkflowSchedulerState, nodeId: string, config: unknown): Record<string, unknown> | undefined {
  const incoming = definition.edges.filter((edge) => edge.targetNodeId === nodeId);
  if (incoming.length === 0) return undefined;
  const buffers = state.joinBuffers?.[nodeId] ?? {};
  // An edge whose bounded budget is exhausted can no longer contribute, so it
  // must not block the barrier. Feedback edges should not target a join; the
  // API validation rejects that shape to keep the barrier forward-only.
  const eligible = incoming.filter((edge) => edge.maxTraversals === undefined
    || (state.edgeTraversals[edge.id] ?? 0) < edge.maxTraversals
    || (buffers[edge.id]?.length ?? 0) > 0);
  if (eligible.length === 0) return undefined;
  if (eligible.some((edge) => (buffers[edge.id]?.length ?? 0) === 0)) return undefined;
  const values = eligible.map((edge) => (buffers[edge.id] as unknown[]).shift());
  for (const edge of eligible) {
    if ((buffers[edge.id]?.length ?? 0) === 0) delete buffers[edge.id];
  }
  if (state.joinBuffers) {
    if (Object.keys(buffers).length === 0) delete state.joinBuffers[nodeId];
    else state.joinBuffers[nodeId] = buffers;
  }
  return { input: orderJoinValues(values, config) };
}

function takeReadyInput(definition: WorkflowDefinition, state: WorkflowSchedulerState, nodeId: string): Record<string, unknown> | undefined {
  const node = definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return undefined;
  const capability = resolveWorkflowNodeCapability(node.type, node.typeVersion);
  if (!capability) throw new Error(`Node Type is not registered: ${node.type}@${node.typeVersion}`);
  if (capability.aggregation === 'join' && definition.edges.some((edge) => edge.targetNodeId === nodeId)) {
    return takeReadyJoinInput(definition, state, nodeId, node.config);
  }
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

/**
 * Rebuild scheduler queues for a new target attempt. The caller activates the
 * target with targetInput after inserting its NodeRun.
 */
export function createWorkflowRerunState(
  definition: WorkflowDefinition,
  currentState: WorkflowSchedulerState,
  targetNodeId: string,
  _targetInput: Record<string, unknown>,
  history: readonly WorkflowRerunHistoryEntry[],
): { state: WorkflowSchedulerState; affectedNodeIds: string[] } {
  const affectedNodeIds = workflowRerunAffectedNodeIds(definition, targetNodeId);
  const affected = new Set(affectedNodeIds);
  const state = structuredClone(currentState);
  const active = state.active;

  state.ready = state.ready.filter((invocation) => !affected.has(invocation.nodeId));
  delete state.active;
  if (active && !affected.has(active.nodeId)) {
    state.ready.unshift({ nodeId: active.nodeId, input: active.input });
  }

  for (const nodeId of affected) {
    delete state.latestOutputs[nodeId];
    delete state.terminalOutputs[nodeId];
    delete state.pendingInputs[nodeId];
    if (state.joinBuffers) delete state.joinBuffers[nodeId];
  }
  for (const edge of definition.edges) {
    if (affected.has(edge.sourceNodeId)) delete state.edgeTraversals[edge.id];
  }

  const latestHistory = new Map<string, WorkflowRerunHistoryEntry>();
  for (const entry of history) {
    const previous = latestHistory.get(entry.nodeId);
    if (!previous || entry.position >= previous.position) latestHistory.set(entry.nodeId, entry);
  }

  for (const node of definition.nodes) {
    if (node.id === targetNodeId || !affected.has(node.id)) continue;
    const storedInput = latestHistory.get(node.id)?.input;
    if (!storedInput || typeof storedInput !== 'object' || Array.isArray(storedInput)) continue;
    const previousInput = storedInput as Record<string, unknown>;
    const capability = resolveWorkflowNodeCapability(node.type, node.typeVersion);
    if (!capability) throw new Error(`Node Type is not registered: ${node.type}@${node.typeVersion}`);
    const incoming = definition.edges.filter((edge) => edge.targetNodeId === node.id);

    if (capability.aggregation === 'join') {
      const values = previousInput.input;
      if (!Array.isArray(values)) continue;
      for (const [index, edge] of incoming.entries()) {
        if (affected.has(edge.sourceNodeId) || index >= values.length) continue;
        state.joinBuffers ??= {};
        const buffers = state.joinBuffers[node.id] ?? {};
        buffers[edge.id] = [structuredClone(values[index])];
        state.joinBuffers[node.id] = buffers;
      }
      continue;
    }

    for (const port of capability.inputs) {
      const incomingForPort = incoming.filter((edge) => edge.targetPort === port.name);
      if (incomingForPort.length === 0
        || incomingForPort.some((edge) => affected.has(edge.sourceNodeId))
        || !Object.hasOwn(previousInput, port.name)) continue;
      const value = previousInput[port.name];
      const values = port.multiple && Array.isArray(value)
        ? structuredClone(value)
        : [structuredClone(value)];
      if (values.length === 0) continue;
      const pending = state.pendingInputs[node.id] ?? {};
      pending[port.name] = values;
      state.pendingInputs[node.id] = pending;
    }
  }

  return { state, affectedNodeIds };
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
    const target = definition.nodes.find((candidate) => candidate.id === edge.targetNodeId);
    const targetCapability = target ? resolveWorkflowNodeCapability(target.type, target.typeVersion) : undefined;
    if (targetCapability?.aggregation === 'join') {
      state.joinBuffers ??= {};
      const nodeBuffers = state.joinBuffers[edge.targetNodeId] ?? {};
      const values = nodeBuffers[edge.id] ?? [];
      values.push(normalizedOutput);
      nodeBuffers[edge.id] = values;
      state.joinBuffers[edge.targetNodeId] = nodeBuffers;
    } else {
      const nodeInputs = state.pendingInputs[edge.targetNodeId] ?? {};
      const values = nodeInputs[edge.targetPort] ?? [];
      values.push(normalizedOutput);
      nodeInputs[edge.targetPort] = values;
      state.pendingInputs[edge.targetNodeId] = nodeInputs;
    }
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
    configSchema: withNodeIdentity({
      type: 'object',
      required: ['agentVersionId'],
      properties: {
        agentVersionId: { type: 'string' },
        outputSchema: { type: 'object' },
      },
    }),
    execute,
  };
}

export type WorkflowSubgraphDefinition = {
  nodes: WorkflowNodeDefinition[];
  edges: WorkflowEdgeDefinition[];
};

export type WorkflowMapBinding = {
  nodeId: string;
  field: string;
  path: string;
};

export type WorkflowMapScope = {
  item: unknown;
  index: number;
  context: unknown;
};

export type WorkflowMapNodeRequest = {
  node: WorkflowNodeDefinition;
  input: Record<string, unknown>;
  config: unknown;
  item: unknown;
  index: number;
  context: unknown;
  signal: AbortSignal;
};

export type WorkflowMapNodeExecutor = (request: WorkflowMapNodeRequest) => Promise<unknown>;

export type ExecuteWorkflowMapRequest = {
  /** The value delivered to the map node's items port; itemsPath is applied here. */
  itemsValue: unknown;
  context: unknown;
  config: unknown;
  executeNode: WorkflowMapNodeExecutor;
  signal: AbortSignal;
  onElementError?: (error: Error, index: number, total: number) => void | Promise<void>;
};

function asWorkflowRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function cloneWorkflowValue<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function readWorkflowSubgraph(value: unknown): WorkflowSubgraphDefinition {
  const record = asWorkflowRecord(value);
  if (!record || !Array.isArray(record.nodes) || !Array.isArray(record.edges)) {
    throw new Error('Map config requires a subgraph containing nodes and edges.');
  }
  return { nodes: record.nodes as WorkflowNodeDefinition[], edges: record.edges as WorkflowEdgeDefinition[] };
}

function readWorkflowMapBindings(value: unknown): WorkflowMapBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Map bindings must be an array.');
  return value.map((entry, index) => {
    const record = asWorkflowRecord(entry);
    if (!record
      || typeof record.nodeId !== 'string' || !record.nodeId.trim()
      || typeof record.field !== 'string' || !record.field.trim()
      || typeof record.path !== 'string' || !record.path.trim()) {
      throw new Error(`Map binding ${index} requires nodeId, field, and path strings.`);
    }
    return { nodeId: record.nodeId.trim(), field: record.field.trim(), path: record.path.trim() };
  });
}

function writeWorkflowConfigPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) throw new Error('Map binding field must be a non-empty path.');
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = asWorkflowRecord(current[segment]);
    if (!existing) {
      const next: Record<string, unknown> = {};
      current[segment] = next;
      current = next;
    } else {
      current = existing;
    }
  }
  current[segments[segments.length - 1]] = cloneWorkflowValue(value);
}

function applyWorkflowMapBindings(config: unknown, bindings: WorkflowMapBinding[], nodeId: string, scope: WorkflowMapScope): unknown {
  const matching = bindings.filter((binding) => binding.nodeId === nodeId);
  if (matching.length === 0) return config;
  const base = asWorkflowRecord(config);
  const next: Record<string, unknown> = base ? structuredClone(base) : {};
  for (const binding of matching) {
    const located = readWorkflowOutputPath(scope, binding.path);
    if (!located.exists) throw new Error(`Map binding path "${binding.path}" does not exist for node "${nodeId}".`);
    writeWorkflowConfigPath(next, binding.field, located.value);
  }
  return next;
}

function throwIfWorkflowAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Workflow execution was aborted.');
}

function injectWorkflowMapEntry(ready: WorkflowScheduledInvocation[], subgraph: WorkflowDefinition, scope: WorkflowMapScope, entryPort: string | undefined): void {
  const rootIds = new Set(subgraph.nodes.filter((node) => !subgraph.edges.some((edge) => edge.targetNodeId === node.id)).map((node) => node.id));
  for (const invocation of ready) {
    if (!rootIds.has(invocation.nodeId)) continue;
    const node = subgraph.nodes.find((candidate) => candidate.id === invocation.nodeId);
    if (!node) continue;
    const capability = resolveWorkflowNodeCapability(node.type, node.typeVersion);
    if (!capability) throw new Error(`Node Type is not registered: ${node.type}@${node.typeVersion}`);
    const port = entryPort ? capability.inputs.find((candidate) => candidate.name === entryPort) : capability.inputs[0];
    if (!port) throw new Error(entryPort
      ? `Map entry port "${entryPort}" does not exist on subgraph root "${node.id}".`
      : `Map subgraph root "${node.id}" has no input port to receive the current item.`);
    invocation.input[port.name] = port.dataType === 'string'
      ? (typeof scope.item === 'string' ? scope.item : JSON.stringify(scope.item))
      : { item: scope.item, index: scope.index, context: scope.context };
  }
}

async function executeWorkflowMapElement(params: {
  subgraph: WorkflowDefinition;
  scope: WorkflowMapScope;
  bindings: WorkflowMapBinding[];
  configuredOutputNodeId: string | undefined;
  entryPort: string | undefined;
  executeNode: WorkflowMapNodeExecutor;
  signal: AbortSignal;
}): Promise<unknown> {
  const { subgraph, scope, bindings, configuredOutputNodeId, entryPort, executeNode, signal } = params;
  const state = createWorkflowSchedulerState(subgraph);
  injectWorkflowMapEntry(state.ready, subgraph, scope, entryPort);

  let invocations = 0;
  while (state.ready.length > 0) {
    throwIfWorkflowAborted(signal);
    const invocation = takeNextWorkflowInvocation(state);
    if (!invocation) break;
    invocations += 1;
    if (invocations > 10000) throw new Error('Map subgraph exceeded the per-element invocation safety limit.');
    const node = subgraph.nodes.find((candidate) => candidate.id === invocation.nodeId);
    if (!node) throw new Error(`Map subgraph references an unavailable node: ${invocation.nodeId}`);
    const configuration = applyWorkflowMapBindings(node.config, bindings, node.id, scope);
    const attempts = node.errorPolicy === 'retry' ? 2 : 1;
    let output: unknown;
    let failure: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        output = await executeNode({
          node,
          input: invocation.input,
          config: configuration,
          item: scope.item,
          index: scope.index,
          context: scope.context,
          signal,
        });
        failure = undefined;
        break;
      } catch (error) {
        failure = error;
        throwIfWorkflowAborted(signal);
      }
    }
    if (failure !== undefined) throw failure instanceof Error ? failure : new Error(String(failure));
    commitWorkflowInvocation(subgraph, state, node.id, output);
  }

  const recordedTerminals = Object.keys(state.terminalOutputs);
  const outputNodeId = configuredOutputNodeId ?? (recordedTerminals.length === 1 ? recordedTerminals[0] : undefined);
  if (!outputNodeId) throw new Error('Map requires outputNodeId when the subgraph has multiple terminal nodes.');
  if (!subgraph.nodes.some((node) => node.id === outputNodeId)) throw new Error(`Map output node "${outputNodeId}" does not exist in the subgraph.`);
  if (!Object.hasOwn(state.terminalOutputs, outputNodeId)) throw new Error(`Map output node "${outputNodeId}" did not produce an output.`);
  return state.terminalOutputs[outputNodeId];
}

/**
 * Image-producing maps run up to three elements concurrently. Other maps stay
 * serial because their subgraphs may depend on ordered side effects. Each element
 * has isolated state, and outputs retain input order.
 */
export async function executeWorkflowMap(request: ExecuteWorkflowMapRequest): Promise<unknown[]> {
  const config = asWorkflowRecord(request.config);
  if (!config) throw new Error('Map node config must be an object.');
  const subgraph = readWorkflowSubgraph(config.subgraph);
  if (subgraph.nodes.length === 0) throw new Error('Map subgraph must contain at least one node.');
  const definition: WorkflowDefinition = {
    schemaVersion: 4,
    input: {},
    defaults: { errorPolicy: 'stop' },
    nodes: subgraph.nodes,
    edges: subgraph.edges,
  };
  validateWorkflowControlFlow(definition);

  const itemsPath = typeof config.itemsPath === 'string' ? config.itemsPath.trim() : '';
  let itemsValue = request.itemsValue;
  if (itemsPath) {
    const located = readWorkflowOutputPath(request.itemsValue, itemsPath);
    if (!located.exists) throw new Error(`Map items path "${itemsPath}" does not exist.`);
    itemsValue = located.value;
  }
  if (!Array.isArray(itemsValue)) throw new Error('Map requires a JSON array on the items port.');
  const items = itemsValue;
  const maxItems = typeof config.maxItems === 'number' && Number.isInteger(config.maxItems) && config.maxItems > 0 ? config.maxItems : undefined;
  if (maxItems !== undefined && items.length > maxItems) {
    throw new Error(`Map received ${items.length} items but maxItems is ${maxItems}.`);
  }
  const continueOnError = config.continueOnError === true;
  const bindings = readWorkflowMapBindings(config.bindings);
  const configuredOutputNodeId = typeof config.outputNodeId === 'string' && config.outputNodeId.trim() ? config.outputNodeId.trim() : undefined;
  const entryPort = typeof config.entryPort === 'string' && config.entryPort.trim() ? config.entryPort.trim() : undefined;
  // A node retry reuses its input, which cannot help when an upstream node produced a bad input
  // (an Agent's script that does not compile). When the subgraph opts into retries, a failed
  // element therefore runs once more from its first node so upstream output is regenerated.
  const elementAttempts = definition.nodes.some((node) => node.errorPolicy === 'retry') ? 2 : 1;
  // Only image-producing subgraphs opt in automatically, including existing published
  // workflows whose configuration predates parallel execution.
  const outputNode = configuredOutputNodeId
    ? definition.nodes.find((node) => node.id === configuredOutputNodeId)
    : definition.nodes.filter((node) => !definition.edges.some((edge) => edge.sourceNodeId === node.id)).length === 1
      ? definition.nodes.find((node) => !definition.edges.some((edge) => edge.sourceNodeId === node.id))
      : undefined;
  const imageOutput = outputNode && ['worklite/image', 'worklite/canvas-render', 'worklite/canvas-sticker'].includes(outputNode.type);
  const concurrency = imageOutput ? 3 : 1;
  const results: Array<{ value: unknown } | undefined> = new Array(items.length);
  const controller = new AbortController();
  const abort = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) abort();
  else request.signal.addEventListener('abort', abort, { once: true });
  let cursor = 0;
  let failure: Error | undefined;

  async function worker(): Promise<void> {
    while (!controller.signal.aborted) {
      const index = cursor++;
      if (index >= items.length) return;
      const scope: WorkflowMapScope = {
        item: cloneWorkflowValue(items[index]),
        index,
        context: cloneWorkflowValue(request.context),
      };
      try {
        let output: unknown;
        for (let attempt = 0; ; attempt += 1) {
          try {
            output = await executeWorkflowMapElement({
              subgraph: definition,
              scope: { ...scope, item: cloneWorkflowValue(scope.item), context: cloneWorkflowValue(scope.context) },
              bindings,
              configuredOutputNodeId,
              entryPort,
              executeNode: request.executeNode,
              signal: controller.signal,
            });
            break;
          } catch (error) {
            if (controller.signal.aborted || attempt + 1 >= elementAttempts) throw error;
          }
        }
        results[index] = { value: output };
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!continueOnError) {
          const message = error instanceof Error ? error.message : String(error);
          failure = new Error(`Map element ${index} failed: ${message}`);
          controller.abort(failure);
          return;
        }
        try {
          await request.onElementError?.(error instanceof Error ? error : new Error(String(error)), index, items.length);
        } catch (callbackError) {
          failure = callbackError instanceof Error ? callbackError : new Error(String(callbackError));
          controller.abort(failure);
          return;
        }
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    if (request.signal.aborted) throwIfWorkflowAborted(request.signal);
    if (failure) throw failure;
    return results.flatMap((entry) => entry ? [entry.value] : []);
  } finally {
    request.signal.removeEventListener('abort', abort);
  }
}

export type ComposeWorkflowArticleConfig = {
  titlePath?: string;
  articlePath?: string;
  unusedImagePolicy?: 'drop' | 'append';
};

const WORKLITE_IMAGE_PLACEHOLDER_PATTERN = /!\[([^\]]*)\]\(\s*worklite-image:([^)\s]+)\s*\)/g;

function readComposeConfigString(config: unknown, key: keyof ComposeWorkflowArticleConfig): string | undefined {
  const record = asWorkflowRecord(config);
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validateComposedWorkflowImage(value: unknown, label: string): { key?: string; imageCount: number } {
  const record = asWorkflowRecord(value);
  if (!record || record.type !== 'workflow_image' || record.mediaType !== 'image/png') {
    throw new Error(`${label} must be a generated workflow_image with mediaType image/png.`);
  }
  if (!Array.isArray(record.data) || record.data.length === 0) throw new Error(`${label} has no image data.`);
  for (const entry of record.data) {
    const data = asWorkflowRecord(entry);
    if (!data || typeof data.b64Json !== 'string' || !data.b64Json) throw new Error(`${label} has invalid image data.`);
  }
  if (record.key !== undefined && (typeof record.key !== 'string' || !record.key.trim())) throw new Error(`${label} has an invalid image key.`);
  return { ...(typeof record.key === 'string' && record.key.trim() ? { key: record.key.trim() } : {}), imageCount: record.data.length };
}

function scanMarkdownH1Headings(markdown: string): string[] {
  const headings: string[] = [];
  let fenceMarker: '`' | '~' | undefined;
  let fenceLength = 0;
  for (const line of markdown.split(/\r?\n/)) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1][0] as '`' | '~';
      const length = fence[1].length;
      if (!fenceMarker) {
        fenceMarker = marker;
        fenceLength = length;
      } else if (marker === fenceMarker && length >= fenceLength && line.trim() === fence[1]) {
        fenceMarker = undefined;
        fenceLength = 0;
      }
      continue;
    }
    if (fenceMarker) continue;
    const heading = /^ {0,3}#(?!#)[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (heading) headings.push(heading[1].trim());
  }
  if (fenceMarker) throw new Error('Compose requires every Markdown code fence to be closed.');
  return headings;
}

/**
 * Deterministic article composition/validation. It never silently repairs the
 * article: a malformed placeholder, missing image, duplicate key, or heading
 * mismatch fails the node so the run surface reports it.
 */
export function composeWorkflowArticle(input: unknown, config: unknown): string {
  const record = asWorkflowRecord(input) ?? {};
  const articleValue = record.article;
  let source: Record<string, unknown> | undefined;
  let markdown: string;
  if (typeof articleValue === 'string') {
    markdown = articleValue;
  } else {
    source = asWorkflowRecord(articleValue);
    if (!source) throw new Error('Compose requires an article string or JSON object.');
    const articlePath = readComposeConfigString(config, 'articlePath') ?? 'article';
    const located = readWorkflowOutputPath(source, articlePath);
    if (!located.exists || typeof located.value !== 'string') throw new Error(`Compose article path "${articlePath}" must resolve to a string.`);
    markdown = located.value;
  }
  const titlePath = readComposeConfigString(config, 'titlePath') ?? 'title';
  let expectedTitle: string | undefined;
  if (source) {
    const located = readWorkflowOutputPath(source, titlePath);
    if (located.exists && typeof located.value === 'string' && located.value.trim()) expectedTitle = located.value.trim();
  }

  const headings = scanMarkdownH1Headings(markdown);
  if (headings.length !== 1) throw new Error(`Compose requires exactly one H1 heading, found ${headings.length}.`);
  if (expectedTitle && headings[0] !== expectedTitle) {
    throw new Error(`Compose H1 "${headings[0]}" does not match title "${expectedTitle}".`);
  }

  const placeholderCount = (markdown.match(/worklite-image:/g) ?? []).length;
  const placeholders = [...markdown.matchAll(WORKLITE_IMAGE_PLACEHOLDER_PATTERN)];
  if (placeholderCount !== placeholders.length) throw new Error('Compose found a malformed worklite-image placeholder.');

  const rawImages = record.images;
  const imageEntries = Array.isArray(rawImages) ? rawImages : [];
  const flattenedImages: unknown[] = [];
  for (const entry of imageEntries) {
    if (Array.isArray(entry)) flattenedImages.push(...entry);
    else flattenedImages.push(entry);
  }
  const imageReferences: Array<{ key?: string; position: number }> = [];
  const explicitKeys = new Set<string>();
  let imagePosition = 0;
  for (const entry of flattenedImages) {
    const image = validateComposedWorkflowImage(entry, 'Inline image');
    if (image.imageCount === 1 && image.key) {
      if (explicitKeys.has(image.key)) throw new Error(`Compose found duplicate image key "${image.key}".`);
      explicitKeys.add(image.key);
    }
    for (let index = 0; index < image.imageCount; index += 1) {
      imagePosition += 1;
      imageReferences.push({ position: imagePosition, ...(image.imageCount === 1 && image.key ? { key: image.key } : {}) });
    }
  }

  const imageByReference = new Map<string, number>();
  for (const image of imageReferences) imageByReference.set(String(image.position), image.position);
  for (const image of imageReferences) if (image.key) imageByReference.set(image.key, image.position);
  const availableKeys = [...imageByReference.keys()].sort();
  const referencedPositions = new Set<number>();
  for (const placeholder of placeholders) {
    const key = placeholder[2];
    const position = imageByReference.get(key);
    if (position === undefined) throw new Error(`Compose placeholder references missing image "${key}". Available keys: ${availableKeys.join(', ') || '(none)'}.`);
    referencedPositions.add(position);
  }

  validateComposedWorkflowImage(record.coverImage, 'Cover image');

  const unused = imageReferences.filter((image) => !referencedPositions.has(image.position));
  const policy = readComposeConfigString(config, 'unusedImagePolicy') ?? 'drop';
  if (policy === 'append' && unused.length > 0) {
    const appended = unused.map((image) => {
      const key = image.key ?? String(image.position);
      return `![${key}](worklite-image:${key})`;
    }).join('\n\n');
    markdown = `${markdown.trimEnd()}\n\n${appended}\n`;
  }
  if (unused.length > 0 && policy === 'drop') {
    // Explicitly documented policy: unused generated images are dropped from the
    // article rather than forced in, keeping the author's outline authoritative.
  }
  return markdown;
}
