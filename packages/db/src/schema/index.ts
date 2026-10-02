import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`);

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(), slug: text('slug').notNull().unique(), name: text('name').notNull(), createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'),
});

export const workspaceSettings = sqliteTable('workspace_settings', {
  workspaceId: text('workspace_id').primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  appearance: text('appearance').$type<'system' | 'light' | 'dark'>().notNull().default('system'),
  updatedAt: timestamp('updated_at'),
});

export const plugins = sqliteTable('plugins', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull(),
  command: text('command').notNull().default('codex'),
  wechatBaseUrl: text('wechat_base_url').notNull().default('https://ilinkai.weixin.qq.com'),
  wechatToken: text('wechat_token'),
  wechatBotId: text('wechat_bot_id'),
  wechatStatus: text('wechat_status').$type<'disconnected' | 'qr_pending' | 'connected' | 'error'>().notNull().default('disconnected'),
  wechatQrCode: text('wechat_qr_code'),
  wechatQrKey: text('wechat_qr_key'),
  wechatCursor: text('wechat_cursor').notNull().default(''),
  wechatLastError: text('wechat_last_error'),
  updatedAt: timestamp('updated_at'),
});

export const pluginWechatConversations = sqliteTable('plugin_wechat_conversations', {
  id: text('id').primaryKey(),
  pluginId: text('plugin_id').notNull().references(() => plugins.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  contextToken: text('context_token'),
  executionId: text('execution_id'),
  updatedAt: timestamp('updated_at'),
}, (table) => [unique().on(table.pluginId, table.userId)]);

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), kind: text('kind').$type<'system' | 'custom'>().notNull().default('custom'), name: text('name').notNull(), responsibility: text('responsibility').notNull(), model: text('model').notNull(), providerId: text('provider_id'),
  systemPrompt: text('system_prompt').notNull().default(''), createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'),
});

export const agentVersions = sqliteTable('agent_versions', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'restrict' }), version: integer('version').notNull(), name: text('name').notNull(), responsibility: text('responsibility').notNull(), systemPrompt: text('system_prompt').notNull(), providerId: text('provider_id'), model: text('model').notNull(), skillIds: text('skill_ids', { mode: 'json' }).$type<string[]>().notNull().default([]), mcpServerIds: text('mcp_server_ids', { mode: 'json' }).$type<string[]>().notNull().default([]), createdAt: timestamp('created_at'),
}, (table) => [unique().on(table.agentId, table.version)]);

export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), name: text('name').notNull(), state: text('state').$type<'draft' | 'published'>().notNull().default('draft'), createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'),
});

export type StoredWorkflowNodePosition = {
  x: number;
  y: number;
};

export type StoredWorkflowNode = {
  id: string;
  position: StoredWorkflowNodePosition;
  type: string;
  typeVersion: string;
  config: unknown;
  errorPolicy: 'stop' | 'retry';
};

export type StoredWorkflowEdgePredicateOperator =
  | 'equals'
  | 'notEquals'
  | 'truthy'
  | 'falsy'
  | 'exists'
  | 'notExists'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual';

export type StoredWorkflowEdgeCondition =
  | {
      kind: 'predicate';
      path: string;
      operator: StoredWorkflowEdgePredicateOperator;
      value?: unknown;
    }
  | { kind: 'fallback' };

export type StoredWorkflowEdge = {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
  condition?: StoredWorkflowEdgeCondition;
  maxTraversals?: number;
};

export type StoredWorkflowScheduledInvocation = {
  nodeId: string;
  input: Record<string, unknown>;
};

export type StoredWorkflowActiveInvocation = StoredWorkflowScheduledInvocation & {
  nodeRunId: string;
  position: number;
};

export type StoredWorkflowExecutionState = {
  ready: StoredWorkflowScheduledInvocation[];
  pendingInputs: Record<string, Record<string, unknown[]>>;
  edgeTraversals: Record<string, number>;
  latestOutputs: Record<string, unknown>;
  terminalOutputs: Record<string, unknown>;
  nextPosition: number;
  active?: StoredWorkflowActiveInvocation;
};

export type StoredWorkflowDefinition = {
  schemaVersion: number;
  input: { example?: unknown };
  defaults: { errorPolicy: 'stop' | 'retry' };
  nodes: StoredWorkflowNode[];
  edges: StoredWorkflowEdge[];
};

export type StoredWorkflowEditOperation =
  | { type: 'addNode'; node: StoredWorkflowNode; index: number }
  | { type: 'removeNode'; nodeId: string }
  | { type: 'updateNode'; nodeId: string; patch: Partial<Omit<StoredWorkflowNode, 'id'>> }
  | { type: 'moveNode'; nodeId: string; position: StoredWorkflowNodePosition }
  | { type: 'addEdge'; edge: StoredWorkflowEdge }
  | { type: 'removeEdge'; edgeId: string }
  | { type: 'updateSettings'; input?: { example?: unknown }; defaults?: { errorPolicy: 'stop' | 'retry' } };

export const emptyWorkflowDefinition: StoredWorkflowDefinition = {
  schemaVersion: 4,
  input: {},
  defaults: { errorPolicy: 'stop' },
  nodes: [],
  edges: [],
};

export const workflowDrafts = sqliteTable('workflow_drafts', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  currentRevisionId: text('current_revision_id'),
  definition: text('definition', { mode: 'json' }).$type<StoredWorkflowDefinition>().notNull().default(emptyWorkflowDefinition),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
}, (table) => [unique().on(table.workflowId)]);

export const workflowEditRevisions = sqliteTable('workflow_edit_revisions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  draftId: text('draft_id').notNull().references(() => workflowDrafts.id, { onDelete: 'cascade' }),
  parentRevisionId: text('parent_revision_id'),
  source: text('source').$type<'manual' | 'assistant' | 'migration'>().notNull(),
  sourceInstruction: text('source_instruction'),
  operations: text('operations', { mode: 'json' }).$type<StoredWorkflowEditOperation[]>().notNull().default([]),
  snapshot: text('snapshot', { mode: 'json' }).$type<StoredWorkflowDefinition>().notNull(),
  createdAt: timestamp('created_at'),
});

export const workflowVersions = sqliteTable('workflow_versions', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }), workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }), version: integer('version').notNull().default(1), published: integer('published', { mode: 'boolean' }).notNull().default(false),
  schemaVersion: integer('schema_version').notNull().default(1), nodes: text('nodes', { mode: 'json' }).$type<StoredWorkflowNode[]>().notNull().default([]), definition: text('definition', { mode: 'json' }).$type<StoredWorkflowDefinition | null>(), sourceRevisionId: text('source_revision_id'), publishedAt: integer('published_at', { mode: 'timestamp_ms' }), publishedBy: text('published_by'), createdAt: timestamp('created_at'),
});

export const workflowSchedules = sqliteTable('workflow_schedules', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }), workflowVersionId: text('workflow_version_id').notNull().references(() => workflowVersions.id, { onDelete: 'restrict' }), intervalSeconds: integer('interval_seconds').notNull(), enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true), running: integer('running', { mode: 'boolean' }).notNull().default(false), nextRunAt: timestamp('next_run_at'), lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }), lastRunId: text('last_run_id'), lastStatus: text('last_status').$type<'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>(), createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'),
}, (table) => [unique().on(table.workflowId), index('workflow_schedules_due_idx').on(table.workspaceId, table.enabled, table.nextRunAt)]);

export const homeBoardCategories = sqliteTable('home_board_categories', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), name: text('name').notNull(), position: integer('position').notNull(), createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'),
}, (table) => [unique('home_board_categories_workspace_name_unique').on(table.workspaceId, table.name), index('home_board_categories_workspace_position_idx').on(table.workspaceId, table.position)]);

export const homeBoardAssignments = sqliteTable('home_board_assignments', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  categoryId: text('category_id').notNull().references(() => homeBoardCategories.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.workflowId] }), index('home_board_assignments_category_idx').on(table.categoryId)]);

export const workflowRuns = sqliteTable('workflow_runs', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }), workflowVersionId: text('workflow_version_id').notNull().references(() => workflowVersions.id, { onDelete: 'restrict' }),
  status: text('status').$type<'queued' | 'running' | 'paused' | 'waiting_for_input' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>().notNull().default('queued'), input: text('input', { mode: 'json' }).$type<unknown>().notNull(), result: text('result', { mode: 'json' }).$type<unknown>(), executionState: text('execution_state', { mode: 'json' }).$type<StoredWorkflowExecutionState>(), currentNodeId: text('current_node_id'),
  createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'), finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
});

export const workflowNodeRuns = sqliteTable('workflow_node_runs', {
  id: text('id').primaryKey(), runId: text('run_id').notNull().references(() => workflowRuns.id, { onDelete: 'cascade' }), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), nodeId: text('node_id').notNull(), position: integer('position').notNull(), type: text('type').notNull(), typeVersion: text('type_version').notNull(), status: text('status').$type<'queued' | 'running' | 'waiting_for_input' | 'succeeded' | 'failed' | 'cancelled'>().notNull().default('queued'), input: text('input', { mode: 'json' }).$type<unknown>(), output: text('output', { mode: 'json' }).$type<unknown>(), artifactIds: text('artifact_ids', { mode: 'json' }).$type<string[]>().notNull().default([]), error: text('error'), retryCount: integer('retry_count').notNull().default(0), startedAt: integer('started_at', { mode: 'timestamp_ms' }), finishedAt: integer('finished_at', { mode: 'timestamp_ms' }), createdAt: timestamp('created_at'),
});

export const workflowPendingActions = sqliteTable('workflow_pending_actions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull().references(() => workflowRuns.id, { onDelete: 'cascade' }),
  nodeRunId: text('node_run_id').notNull().references(() => workflowNodeRuns.id, { onDelete: 'cascade' }),
  type: text('type').$type<'wechat_login' | 'wechat_publish_confirmation'>().notNull(),
  status: text('status').$type<'pending' | 'completed' | 'expired' | 'cancelled'>().notNull().default('pending'),
  title: text('title').notNull(),
  description: text('description').notNull(),
  qrCode: text('qr_code'),
  externalOperationId: text('external_operation_id'),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
}, (table) => [index('workflow_pending_actions_run_status_idx').on(table.runId, table.status)]);

export const wechatOfficialAccounts = sqliteTable('wechat_official_accounts', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  status: text('status').$type<'disconnected' | 'qr_pending' | 'connected' | 'error'>().notNull().default('disconnected'),
  encryptedStorageState: text('encrypted_storage_state'),
  qrCode: text('qr_code'),
  qrExpiresAt: integer('qr_expires_at', { mode: 'timestamp_ms' }),
  lastVerifiedAt: integer('last_verified_at', { mode: 'timestamp_ms' }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
}, (table) => [unique().on(table.workspaceId, table.displayName)]);

export const wechatPublications = sqliteTable('wechat_publications', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull().references(() => wechatOfficialAccounts.id, { onDelete: 'restrict' }),
  runId: text('run_id').notNull().references(() => workflowRuns.id, { onDelete: 'cascade' }),
  nodeRunId: text('node_run_id').notNull().references(() => workflowNodeRuns.id, { onDelete: 'cascade' }),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  mode: text('mode').$type<'draft' | 'publish'>().notNull(),
  status: text('status').$type<'preparing' | 'draft_saved' | 'confirmation_pending' | 'published' | 'failed'>().notNull().default('preparing'),
  title: text('title').notNull(),
  article: text('article').notNull(),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  draftId: text('draft_id'),
  publishedUrl: text('published_url'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
});

export const workflowRunEvents = sqliteTable('workflow_run_events', {
  runId: text('run_id').notNull().references(() => workflowRuns.id, { onDelete: 'cascade' }), sequence: integer('sequence').notNull(), type: text('type').$type<'run.status' | 'node.started' | 'node.delta' | 'node.waiting' | 'node.completed' | 'node.failed' | 'node.activity' | 'pending_action.updated' | 'artifact.created'>().notNull(), payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(), createdAt: timestamp('created_at'),
}, (table) => [primaryKey({ columns: [table.runId, table.sequence] })]);

export const commandExecutions = sqliteTable('command_executions', {
  id: text('id').primaryKey(),
  command: text('command').notNull(),
  cwd: text('cwd').notNull(),
  status: text('status').$type<'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'>().notNull().default('queued'),
  pid: integer('pid'),
  exitCode: integer('exit_code'),
  signal: text('signal'),
  createdAt: timestamp('created_at'),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }),
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
});

export const commandExecutionEvents = sqliteTable('command_execution_events', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  commandId: text('command_id').notNull().references(() => commandExecutions.id, { onDelete: 'cascade' }),
  type: text('type').$type<'stdout' | 'stderr' | 'lifecycle'>().notNull(),
  data: text('data').notNull(),
  createdAt: timestamp('created_at'),
}, (table) => [index('command_execution_events_command_sequence_idx').on(table.commandId, table.sequence)]);

export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), name: text('name').notNull(), source: text('source').$type<'online' | 'archive' | 'built-in'>().notNull(), version: text('version').notNull().default('draft'), validation: text('validation').$type<'valid' | 'invalid' | 'pending'>().notNull().default('pending'), instructions: text('instructions').notNull().default(''), updatedAt: timestamp('updated_at'),
});

export const skillFiles = sqliteTable('skill_files', {
  skillId: text('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  content: text('content').notNull().default(''),
}, (table) => [primaryKey({ columns: [table.skillId, table.path] })]);

export type StoredAgentModelMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }> }
  | { role: 'tool'; content: Array<{ type: 'tool-result'; toolCallId: string; toolName: string; output: { type: 'text' | 'error-text'; value: string } }> };

export type StoredAgentDisplayMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

export type StoredAgentPlanStep = {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
};

export type StoredAgentPendingQuestion = {
  id: string;
  question: string;
  options: string[];
  createdAt: string;
};

export type StoredWorkliteScriptResult =
  | { type: 'resource'; resourceType: 'provider' | 'skill' | 'mcp-server' | 'workflow'; id: string; route: string }
  | { type: 'navigation'; target: 'home' | 'skills' | 'mcp-servers' | 'model-providers' | 'logs' | 'workflows' | 'settings-appearance' | 'settings-usage' | 'settings-audit-log'; route: string }
  | { type: 'settings'; appearance: 'system' | 'light' | 'dark' }
  | { type: 'snapshot' };

export const agentExecutions = sqliteTable('agent_executions', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }), status: text('status').$type<'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled'>().notNull().default('running'), phase: text('phase').$type<'model' | 'skill' | 'recovery'>().notNull().default('model'), errorCode: text('error_code').$type<'provider' | 'invalid_request' | 'invalid_tool_request' | 'incomplete_tool_request' | 'too_many_tool_calls' | 'skill' | 'mcp' | 'restarted' | 'internal'>(), modelMessages: text('model_messages', { mode: 'json' }).$type<StoredAgentModelMessage[]>().notNull().default([]), displayMessages: text('display_messages', { mode: 'json' }).$type<StoredAgentDisplayMessage[]>().notNull().default([]), plan: text('plan', { mode: 'json' }).$type<StoredAgentPlanStep[]>().notNull().default([]), pendingQuestion: text('pending_question', { mode: 'json' }).$type<StoredAgentPendingQuestion | null>(), contextDropped: integer('context_dropped').notNull().default(0), error: text('error'), createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'),
});

export const agentExecutionEvents = sqliteTable('agent_execution_events', {
  executionId: text('execution_id').notNull().references(() => agentExecutions.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  data: text('data', { mode: 'json' }).$type<unknown>().notNull(),
  createdAt: timestamp('created_at'),
}, (table) => [primaryKey({ columns: [table.executionId, table.sequence] })]);

export const agentSubSessions = sqliteTable('agent_sub_sessions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  executionId: text('execution_id').notNull().unique().references(() => agentExecutions.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  unread: integer('unread', { mode: 'boolean' }).notNull().default(false),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
}, (table) => [index('agent_sub_sessions_workspace_updated_idx').on(table.workspaceId, table.updatedAt)]);

export const agentToolCalls = sqliteTable('agent_tool_calls', {
  id: text('id').primaryKey(), executionId: text('execution_id').notNull().references(() => agentExecutions.id, { onDelete: 'cascade' }), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }), toolCallId: text('tool_call_id').notNull(), toolName: text('tool_name').$type<'skill_script' | 'builtin' | 'mcp'>().notNull(), workingDirectory: text('working_directory').notNull(), skillId: text('skill_id'), skillName: text('skill_name'), scriptPath: text('script_path'), mcpServerId: text('mcp_server_id'), mcpToolName: text('mcp_tool_name'), arguments: text('arguments', { mode: 'json' }).$type<string[]>().notNull().default([]), input: text('input', { mode: 'json' }).$type<unknown>(), packageFiles: text('package_files', { mode: 'json' }).$type<Array<{ path: string; content: string }>>().notNull().default([]), commandExecutionId: text('command_execution_id').references(() => commandExecutions.id, { onDelete: 'set null' }), status: text('status').$type<'running' | 'completed' | 'failed' | 'cancelled'>().notNull().default('running'), output: text('output').notNull().default(''), result: text('result', { mode: 'json' }).$type<StoredWorkliteScriptResult>(), exitCode: integer('exit_code'), resultAppended: integer('result_appended', { mode: 'boolean' }).notNull().default(false), createdAt: timestamp('created_at'), finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
});

export const scheduledAgentTasks = sqliteTable('scheduled_agent_tasks', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }), label: text('label').notNull(), prompt: text('prompt').notNull(), intervalSeconds: integer('interval_seconds').notNull(), nextRunAt: timestamp('next_run_at'), activeExecutionId: text('active_execution_id'), lastRunAt: timestamp('last_run_at'), lastStatus: text('last_status').$type<'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled'>(), unread: integer('unread', { mode: 'boolean' }).notNull().default(false), running: integer('running', { mode: 'boolean' }).notNull().default(false), createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'),
}, (table) => [index('scheduled_agent_tasks_workspace_next_run_idx').on(table.workspaceId, table.nextRunAt)]);

export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), name: text('name').notNull(), endpoint: text('endpoint').notNull().default(''), connection: text('connection').$type<'connected' | 'unreachable' | 'auth_failed' | 'unconfigured'>().notNull().default('unconfigured'), transport: text('transport').notNull().default('Streamable HTTP'), allowedTools: integer('allowed_tools').notNull().default(0), allowedToolNames: text('allowed_tool_names', { mode: 'json' }).$type<string[]>().notNull().default([]), version: text('version').notNull().default('v1'), authSecret: text('auth_secret'), updatedAt: timestamp('updated_at'),
});

export const agentSkills = sqliteTable('agent_skills', {
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  skillId: text('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
}, (table) => [primaryKey({ columns: [table.agentId, table.skillId] })]);

export const agentMcpServers = sqliteTable('agent_mcp_servers', {
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  mcpServerId: text('mcp_server_id').notNull().references(() => mcpServers.id, { onDelete: 'cascade' }),
}, (table) => [primaryKey({ columns: [table.agentId, table.mcpServerId] })]);


export type StoredAgentTeamRole =
  | 'planner'
  | 'test_designer'
  | 'developer'
  | 'test_author'
  | 'test_runner'
  | 'reviewer';

export type StoredAgentTeamMode = 'plan_only' | 'validate_existing' | 'implement_and_validate';

export type StoredAgentTeamSkillSnapshot = {
  id: string;
  name: string;
  files: Array<{ path: string; content: string }>;
};

export type StoredAgentTeamMcpServerSnapshot = {
  id: string;
  name: string;
  allowedToolNames: string[];
};

export type StoredAgentTeamRoleConfiguration = {
  role: StoredAgentTeamRole;
  publicModelId: string;
  instructions: string;
  entryPoints: string[];
  skills: StoredAgentTeamSkillSnapshot[];
  mcpServers: StoredAgentTeamMcpServerSnapshot[];
  toolNames: string[];
};

export type StoredAgentTeamRecipeDefaults = {
  maxRepairRounds: number;
};

export type StoredAgentTeamVersionSnapshot = {
  processId: string;
  processVersion: string;
  roles: StoredAgentTeamRoleConfiguration[];
  recipeDefaults: StoredAgentTeamRecipeDefaults;
};

export const agentTeams = sqliteTable('agent_teams', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull(),
  processId: text('process_id').notNull(),
  processVersion: text('process_version').notNull(),
  roles: text('roles', { mode: 'json' }).$type<StoredAgentTeamRoleConfiguration[]>().notNull().default([]),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
}, (table) => [unique().on(table.workspaceId, table.name)]);

export const agentTeamVersions = sqliteTable('agent_team_versions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull().references(() => agentTeams.id, { onDelete: 'restrict' }),
  version: integer('version').notNull(),
  snapshot: text('snapshot', { mode: 'json' }).$type<StoredAgentTeamVersionSnapshot>().notNull(),
  createdAt: timestamp('created_at'),
}, (table) => [unique().on(table.teamId, table.version)]);

export const agentTeamRuns = sqliteTable('agent_team_runs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull().references(() => agentTeams.id, { onDelete: 'restrict' }),
  teamVersionId: text('team_version_id').notNull().references(() => agentTeamVersions.id, { onDelete: 'restrict' }),
  status: text('status').$type<'queued' | 'running' | 'waiting_for_input' | 'paused' | 'succeeded' | 'failed' | 'cancelled'>().notNull().default('queued'),
  intent: text('intent').notNull(),
  projectDirectory: text('project_directory').notNull(),
  mode: text('mode').$type<StoredAgentTeamMode>().notNull(),
  scopeRevision: integer('scope_revision').notNull().default(1),
  desiredControlState: text('desired_control_state').$type<'none' | 'pause_requested' | 'cancel_requested'>().notNull().default('none'),
  langGraphThreadId: text('lang_graph_thread_id').notNull().unique(),
  outcome: text('outcome', { mode: 'json' }).$type<unknown>(),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
}, (table) => [index('agent_team_runs_workspace_created_idx').on(table.workspaceId, table.createdAt)]);

export const agentTeamTaskAttempts = sqliteTable('agent_team_task_attempts', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull().references(() => agentTeamRuns.id, { onDelete: 'cascade' }),
  taskKey: text('task_key').notNull(),
  attemptIndex: integer('attempt_index').notNull(),
  role: text('role').$type<StoredAgentTeamRole>().notNull(),
  status: text('status').$type<'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled'>().notNull().default('running'),
  inputRevision: text('input_revision', { mode: 'json' }).$type<unknown>().notNull(),
  inputFingerprint: text('input_fingerprint').notNull(),
  result: text('result', { mode: 'json' }).$type<unknown>(),
  error: text('error'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: timestamp('created_at'),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }),
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
}, (table) => [
  unique().on(table.runId, table.taskKey, table.attemptIndex),
  index('agent_team_task_attempts_run_task_idx').on(table.runId, table.taskKey),
]);

export const agentTeamDocuments = sqliteTable('agent_team_documents', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull().references(() => agentTeamRuns.id, { onDelete: 'cascade' }),
  taskAttemptId: text('task_attempt_id').notNull().references(() => agentTeamTaskAttempts.id, { onDelete: 'restrict' }),
  key: text('key').notNull(),
  revision: integer('revision').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  upstreamDocumentKeys: text('upstream_document_keys', { mode: 'json' }).$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at'),
}, (table) => [
  unique().on(table.runId, table.key, table.revision),
  index('agent_team_documents_run_idx').on(table.runId, table.createdAt),
]);

export const agentTeamRunEvents = sqliteTable('agent_team_run_events', {
  runId: text('run_id').notNull().references(() => agentTeamRuns.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  type: text('type').$type<'run.status' | 'task.started' | 'task.delta' | 'task.waiting' | 'task.completed' | 'task.failed' | 'document.committed' | 'operation.updated' | 'input.requested' | 'input.answered' | 'run.outcome'>().notNull(),
  payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
  createdAt: timestamp('created_at'),
}, (table) => [primaryKey({ columns: [table.runId, table.sequence] })]);

export const agentTeamPendingInputs = sqliteTable('agent_team_pending_inputs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull().references(() => agentTeamRuns.id, { onDelete: 'cascade' }),
  taskAttemptId: text('task_attempt_id').notNull().references(() => agentTeamTaskAttempts.id, { onDelete: 'cascade' }),
  question: text('question').notNull(),
  scopeRevision: integer('scope_revision').notNull(),
  status: text('status').$type<'pending' | 'answered' | 'cancelled'>().notNull().default('pending'),
  answer: text('answer'),
  createdAt: timestamp('created_at'),
  answeredAt: integer('answered_at', { mode: 'timestamp_ms' }),
  updatedAt: timestamp('updated_at'),
}, (table) => [index('agent_team_pending_inputs_run_status_idx').on(table.runId, table.status)]);

export const agentTeamOperations = sqliteTable('agent_team_operations', {
  key: text('key').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull().references(() => agentTeamRuns.id, { onDelete: 'cascade' }),
  taskAttemptId: text('task_attempt_id').notNull().references(() => agentTeamTaskAttempts.id, { onDelete: 'cascade' }),
  taskKey: text('task_key').notNull(),
  operationKey: text('operation_key').notNull(),
  toolName: text('tool_name').notNull(),
  inputFingerprint: text('input_fingerprint').notNull(),
  status: text('status').$type<'reserved' | 'completed' | 'uncertain' | 'failed'>().notNull().default('reserved'),
  commandId: text('command_id').references(() => commandExecutions.id, { onDelete: 'set null' }),
  result: text('result', { mode: 'json' }).$type<unknown>(),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
}, (table) => [
  index('agent_team_operations_run_idx').on(table.runId, table.taskKey),
  unique().on(table.runId, table.taskKey, table.operationKey),
]);

export const modelProviders = sqliteTable('model_providers', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), name: text('name').notNull(), baseURL: text('base_url'), protocol: text('protocol').$type<'openai/chat' | 'openai/responses' | 'anthropic/messages' | 'codex/responses'>().notNull().default('openai/chat'), status: text('status').$type<'connected' | 'unconfigured' | 'invalid'>().notNull().default('unconfigured'), maskedKey: text('masked_key').notNull().default(''), models: text('models', { mode: 'json' }).$type<string[]>().notNull().default([]), apiKey: text('api_key'), headers: text('headers'), updatedAt: timestamp('updated_at'),
});

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), workflowId: text('workflow_id').references(() => workflows.id, { onDelete: 'set null' }), runId: text('run_id').references(() => workflowRuns.id, { onDelete: 'set null' }), name: text('name').notNull(), type: text('type').$type<'json' | 'text' | 'markdown' | 'unsupported'>().notNull(), size: text('size').notNull().default('0 B'), content: text('content').notNull().default(''), objectKey: text('object_key'), createdAt: timestamp('created_at'),
});

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), actorId: text('actor_id'), action: text('action').notNull(), resource: text('resource').notNull(), metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}), createdAt: timestamp('created_at'),
});

export type Workspace = typeof workspaces.$inferSelect;
export type Plugin = typeof plugins.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type AgentVersion = typeof agentVersions.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type WorkflowDraft = typeof workflowDrafts.$inferSelect;
export type WorkflowEditRevision = typeof workflowEditRevisions.$inferSelect;
export type WorkflowVersion = typeof workflowVersions.$inferSelect;
export type HomeBoardCategory = typeof homeBoardCategories.$inferSelect;
export type HomeBoardAssignment = typeof homeBoardAssignments.$inferSelect;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type WorkflowNodeRun = typeof workflowNodeRuns.$inferSelect;
export type WorkflowRunEvent = typeof workflowRunEvents.$inferSelect;
export type CommandExecution = typeof commandExecutions.$inferSelect;
export type CommandExecutionEvent = typeof commandExecutionEvents.$inferSelect;
export type Skill = typeof skills.$inferSelect;
export type SkillFile = typeof skillFiles.$inferSelect;
export type AgentExecution = typeof agentExecutions.$inferSelect;
export type AgentSubSession = typeof agentSubSessions.$inferSelect;
export type AgentToolCall = typeof agentToolCalls.$inferSelect;
export type ScheduledAgentTask = typeof scheduledAgentTasks.$inferSelect;
export type McpServer = typeof mcpServers.$inferSelect;
export type ModelProvider = typeof modelProviders.$inferSelect;
export type AgentTeam = typeof agentTeams.$inferSelect;
export type AgentTeamVersion = typeof agentTeamVersions.$inferSelect;
export type AgentTeamRun = typeof agentTeamRuns.$inferSelect;
export type AgentTeamTaskAttempt = typeof agentTeamTaskAttempts.$inferSelect;
export type AgentTeamDocument = typeof agentTeamDocuments.$inferSelect;
export type AgentTeamRunEvent = typeof agentTeamRunEvents.$inferSelect;
export type AgentTeamPendingInput = typeof agentTeamPendingInputs.$inferSelect;
export type AgentTeamOperation = typeof agentTeamOperations.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
