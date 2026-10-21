import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, unique, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

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
  feishuAppId: text('feishu_app_id').notNull().default(''),
  feishuAppSecret: text('feishu_app_secret'),
  feishuAllowedUserId: text('feishu_allowed_user_id').notNull().default(''),
  feishuEnabled: integer('feishu_enabled', { mode: 'boolean' }).notNull().default(false),
  feishuStatus: text('feishu_status').$type<'disconnected' | 'connecting' | 'connected' | 'error'>().notNull().default('disconnected'),
  feishuLastError: text('feishu_last_error'),
  wechatBotId: text('wechat_bot_id').notNull().default(''),
  wechatBotToken: text('wechat_bot_token'),
  wechatBaseUrl: text('wechat_base_url').notNull().default(''),
  wechatAllowedUserId: text('wechat_allowed_user_id').notNull().default(''),
  wechatEnabled: integer('wechat_enabled', { mode: 'boolean' }).notNull().default(false),
  wechatStatus: text('wechat_status').$type<'disconnected' | 'connecting' | 'connected' | 'error'>().notNull().default('disconnected'),
  wechatLastError: text('wechat_last_error'),
  wechatSyncBuf: text('wechat_sync_buf').notNull().default(''),
  updatedAt: timestamp('updated_at'),
});

export const feishuRegistrations = sqliteTable('feishu_registrations', {
  pluginId: text('plugin_id').primaryKey().references(() => plugins.id, { onDelete: 'cascade' }),
  id: text('id').notNull().unique(),
  status: text('status').$type<'pending' | 'completed' | 'needs_user_id' | 'denied' | 'expired' | 'error' | 'cancelled'>().notNull(),
  deviceCode: text('device_code'),
  verificationUrl: text('verification_url'),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  intervalSeconds: integer('interval_seconds').notNull().default(5),
  nextPollAt: integer('next_poll_at', { mode: 'timestamp_ms' }),
  error: text('error'),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
});

export type StoredChatTarget =
  | { kind: 'conversation' }
  | { kind: 'team'; teamId: string; projectDirectory: string; mode: 'plan_only' | 'validate_existing' | 'implement_and_validate' }
  | { kind: 'workflow'; workflowId: string };
export type StoredChatTaskReference =
  | { kind: 'conversation'; executionId: string; afterMessageId: string | null; afterSequence: number; untilMessageId?: string | null; completionStatus?: string; completionError?: string | null }
  | { kind: 'team'; teamId: string; runId: string }
  | { kind: 'workflow'; runId: string; workflowVersionId: string }
  | { kind: 'upgrade'; jobId: string };

// Channel-neutral external chat binding shared by every external conversation
// channel. `channel + externalId` identifies the platform chat; Feishu rows
// migrated from `feishu_chats` keep their bare chat id as `id`, WeChat rows
// use `wechat:<ilink_user_id>`. `contextToken` carries the iLink reply context
// WeChat must echo on outbound sends; it stays null for Feishu.
export const externalChats = sqliteTable('external_chats', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  channel: text('channel').$type<'feishu' | 'wechat'>().notNull(),
  externalId: text('external_id').notNull(),
  userId: text('user_id').notNull(),
  executionId: text('execution_id'),
  contextToken: text('context_token'),
  target: text('target', { mode: 'json' }).$type<StoredChatTarget>().notNull().default({ kind: 'conversation' }),
  updatedAt: timestamp('updated_at'),
});

export const chatSubmissions = sqliteTable('chat_submissions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  chatId: text('chat_id').references(() => externalChats.id, { onDelete: 'cascade' }),
  executionId: text('execution_id'),
  message: text('message').notNull(),
  target: text('target', { mode: 'json' }).$type<StoredChatTarget>().notNull(),
  reference: text('reference', { mode: 'json' }).$type<StoredChatTaskReference>(),
  outputMessageId: text('output_message_id'),
  renderedCard: text('rendered_card', { mode: 'json' }).$type<Record<string, unknown>>(),
  // Per-project-task Feishu cards of this submission, keyed by task id; each entry carries its own transport.
  renderedTaskCards: text('rendered_task_cards', { mode: 'json' }).$type<Record<string, Record<string, unknown>>>(),
  deliveryFingerprint: text('delivery_fingerprint'),
  settled: integer('settled', { mode: 'boolean' }).notNull().default(false),
  reportedAt: integer('reported_at', { mode: 'timestamp_ms' }),
  error: text('error'),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
}, (table) => [index('chat_submissions_execution_idx').on(table.executionId)]);

export const feishuEvents = sqliteTable('feishu_events', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => externalChats.id, { onDelete: 'cascade' }),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  status: text('status').$type<'queued' | 'done' | 'failed'>().notNull().default('queued'),
  error: text('error'),
  createdAt: timestamp('created_at'),
}, (table) => [index('feishu_events_chat_idx').on(table.chatId)]);

export const feishuDeliveries = sqliteTable('feishu_deliveries', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => externalChats.id, { onDelete: 'cascade' }),
  messageId: text('message_id'),
});

export const wechatEvents = sqliteTable('wechat_events', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => externalChats.id, { onDelete: 'cascade' }),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  status: text('status').$type<'queued' | 'done' | 'failed'>().notNull().default('queued'),
  error: text('error'),
  createdAt: timestamp('created_at'),
}, (table) => [index('wechat_events_chat_idx').on(table.chatId)]);

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
  progressReport?: {
    items: Array<{ kind: 'task' | 'team' | 'workflow'; id: string; title: string; status: string }>;
  };
  // A summary divider marks where a /summarize compressed the model context; its content
  // retains the generated summary so a later summarize can build on it.
  kind?: 'summary_divider';
};

export type StoredAgentPlanStep = {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
};

export type StoredAgentPendingQuestion = {
  action?: 'new_conversation' | 'confirm_execution';
  id: string;
  question: string;
  options: string[];
  createdAt: string;
  projectTaskId?: string;
  shellCallId?: string;
  recovery?: { operationKey: string; commandExecutionId?: string };
};

export type StoredWorkliteScriptResult =
  | { type: 'resource'; resourceType: 'provider' | 'skill' | 'mcp-server' | 'workflow'; id: string; route: string }
  | { type: 'navigation'; target: 'home' | 'chat' | 'skills' | 'mcp-servers' | 'model-providers' | 'logs' | 'workflows' | 'settings-appearance' | 'settings-usage' | 'settings-audit-log' | `/workflows/${string}`; route: string }
  | { type: 'dispatch'; submissionId: string; route: string }
  | { type: 'settings'; appearance: 'system' | 'light' | 'dark' }
  | { type: 'snapshot' };

export type StoredProjectExecutor = 'codex' | 'claude';

export type StoredChatCapabilities = {
  revision: number;
  defaultExecutor?: StoredProjectExecutor;
  defaultExecutorModels?: Partial<Record<StoredProjectExecutor, string>>;
  agent: { id: string; providerId: string | null; model: string; systemPrompt: string };
  skills: Array<{ id: string; name: string; instructions: string; files: Array<{ path: string; content: string }> }>;
  mcpServers: Array<{ id: string; name: string; endpoint: string; authSecret: string | null; allowedTools: string[] }>;
};

export const chatConfigurations = sqliteTable('chat_bot_configurations', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  extensionPrompt: text('extension_prompt').notNull().default(''),
  // Custom /summarize prompt; an empty string falls back to the built-in default at summarize time.
  summarizePrompt: text('summarize_prompt').notNull().default(''),
  defaultExecutor: text('default_executor').$type<StoredProjectExecutor>().notNull().default('claude'),
  // Per-executor declared default Gateway public model ids; an absent key falls back to the executor's own default.
  defaultExecutorModels: text('default_executor_models', { mode: 'json' }).$type<Partial<Record<StoredProjectExecutor, string>>>().notNull().default({}),
  // Workspace MCP servers injected into Claude Code project tasks; empty keeps the executor's launch unchanged.
  projectTaskMcpServerIds: text('project_task_mcp_server_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  providerId: text('provider_id'), model: text('model').notNull(),
  skillIds: text('skill_ids', { mode: 'json' }).$type<string[]>().notNull(),
  mcpServerIds: text('mcp_server_ids', { mode: 'json' }).$type<string[]>().notNull(),
  createdAt: timestamp('created_at'),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.revision] })]);

// Keep in sync with CHAT_MEMORY_CATEGORIES in @worklite/contracts, which owns the
// category metadata (injection behavior) shared by the API and Web client.
export type ChatMemoryCategory = 'rule' | 'preference' | 'project' | 'project_state' | 'workflow' | 'other';

export const chatMemories = sqliteTable('chat_memories', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  category: text('category').$type<ChatMemoryCategory>().notNull().default('other'),
  sourceConversationId: text('source_conversation_id'),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
}, (table) => [index('chat_memories_workspace_updated_idx').on(table.workspaceId, table.updatedAt)]);

export type StoredChatExecutionAuthorization = {
  id: string;
  questionId: string;
  proposal: string;
  status: 'pending' | 'approved' | 'declined';
  approvedAt: string | null;
  createdAt: string;
};

export const agentExecutions = sqliteTable('agent_executions', {
  executionAuthorization: text('execution_authorization', { mode: 'json' }).$type<StoredChatExecutionAuthorization | null>(),
  capabilitySnapshot: text('capability_snapshot', { mode: 'json' }).$type<StoredChatCapabilities | null>(),
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }), status: text('status').$type<'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled'>().notNull().default('running'), phase: text('phase').$type<'model' | 'skill' | 'recovery'>().notNull().default('model'), errorCode: text('error_code').$type<'provider' | 'provider_request' | 'invalid_request' | 'invalid_tool_request' | 'incomplete_tool_request' | 'missing_tool_results' | 'too_many_tool_calls' | 'skill' | 'mcp' | 'restarted' | 'internal'>(), modelMessages: text('model_messages', { mode: 'json' }).$type<StoredAgentModelMessage[]>().notNull().default([]), displayMessages: text('display_messages', { mode: 'json' }).$type<StoredAgentDisplayMessage[]>().notNull().default([]), plan: text('plan', { mode: 'json' }).$type<StoredAgentPlanStep[]>().notNull().default([]), pendingQuestion: text('pending_question', { mode: 'json' }).$type<StoredAgentPendingQuestion | null>(), contextDropped: integer('context_dropped').notNull().default(0), error: text('error'), createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'),
}, (table) => [index('agent_executions_workspace_agent_updated_idx').on(table.workspaceId, table.agentId, table.updatedAt)]);

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

export type StoredChatShellCall = {
  command: string;
  state: 'awaiting_confirmation' | 'authorized' | 'reserved' | 'uncertain' | 'settled';
  authorizationId?: string;
  approvedAt?: string;
};

export const agentToolCalls = sqliteTable('agent_tool_calls', {
  shell: text('shell', { mode: 'json' }).$type<StoredChatShellCall | null>(),
  id: text('id').primaryKey(), executionId: text('execution_id').notNull().references(() => agentExecutions.id, { onDelete: 'cascade' }), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }), toolCallId: text('tool_call_id').notNull(), toolName: text('tool_name').$type<'skill_script' | 'builtin' | 'mcp'>().notNull(), workingDirectory: text('working_directory').notNull(), skillId: text('skill_id'), skillName: text('skill_name'), scriptPath: text('script_path'), mcpServerId: text('mcp_server_id'), mcpToolName: text('mcp_tool_name'), arguments: text('arguments', { mode: 'json' }).$type<string[]>().notNull().default([]), input: text('input', { mode: 'json' }).$type<unknown>(), packageFiles: text('package_files', { mode: 'json' }).$type<Array<{ path: string; content: string }>>().notNull().default([]), commandExecutionId: text('command_execution_id').references(() => commandExecutions.id, { onDelete: 'set null' }), status: text('status').$type<'running' | 'completed' | 'failed' | 'cancelled'>().notNull().default('running'), output: text('output').notNull().default(''), result: text('result', { mode: 'json' }).$type<StoredWorkliteScriptResult>(), exitCode: integer('exit_code'), resultAppended: integer('result_appended', { mode: 'boolean' }).notNull().default(false), createdAt: timestamp('created_at'), finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
}, (table) => [index('agent_tool_calls_execution_idx').on(table.executionId)]);

// Captured launch of a project executor. Codex always uses the ~/.codex-cli home through the WorkLite Gateway;
// Claude Code uses the operator's ~/.claude configuration, whose effective base URL must be the Gateway.
// model is the effective model for the task and modelSource states where it came from: the task parameter,
// the Chat configuration's declared default for that executor, or the executor's own local default.
export type StoredProjectExecutorModelSource = 'task' | 'configuration' | 'executor';
export type StoredProjectExecutorLaunch =
  | { executor: 'codex'; commandArguments: string[]; home: string; model: string; modelProvider: string; settings: Record<string, unknown>; modelSource?: StoredProjectExecutorModelSource }
  | { executor: 'claude'; commandArguments: string[]; baseUrl: string; model: string | null; modelSource?: StoredProjectExecutorModelSource };

export type StoredChatProjectTaskSnapshot = {
  launch?: StoredProjectExecutorLaunch;
  projectInstructions: Array<{ path: string; content: string }>;
  capabilities: StoredChatCapabilities;
  readOnly?: boolean;
};

// A user-submitted mid-task steer instruction. Codex may deliver it to the live turn through
// turn/steer; Claude Code has no native mid-turn input, so its instructions queue here and are
// handed to the task's next run as part of the goal, carrying the prior run's evidence.
export type StoredProjectTaskSteerInstruction = {
  id: string;
  text: string;
  createdAt: string;
  // 'delivered': Codex accepted it into the live turn through turn/steer, evidence only.
  // 'queued': waiting for the task's next run (Claude Code, or a Codex turn that could not accept it).
  // 'consumed': a queued instruction the next run has picked up and included in its goal.
  status: 'delivered' | 'queued' | 'consumed';
};

// Table names keep their original codex prefix as persisted identifiers.
export const chatProjectTasks = sqliteTable('chat_codex_tasks', {
  id: text('id').primaryKey().references(() => agentToolCalls.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  executionId: text('execution_id').notNull().references(() => agentExecutions.id, { onDelete: 'cascade' }),
  goal: text('goal').notNull(), projectDirectory: text('project_directory').notNull(), model: text('model').notNull(),
  snapshot: text('snapshot', { mode: 'json' }).$type<StoredChatProjectTaskSnapshot>().notNull(),
  status: text('status').$type<'running' | 'waiting_for_input' | 'waiting_for_recovery' | 'succeeded' | 'failed' | 'cancelled'>().notNull(),
  answers: text('answers', { mode: 'json' }).$type<Array<{ question: string; answer: string }>>().notNull().default([]),
  pendingQuestion: text('pending_question', { mode: 'json' }).$type<StoredAgentPendingQuestion | null>(),
  activities: text('activities', { mode: 'json' }).$type<Array<Record<string, unknown>>>().notNull().default([]),
  // Mid-run steer instructions the user submitted while this task was active, in submission order.
  // A delivered or superseded entry is historical evidence; a queued entry is consumed by the next run.
  steerQueue: text('steer_queue', { mode: 'json' }).$type<StoredProjectTaskSteerInstruction[]>().notNull().default([]),
  result: text('result').notNull().default(''), error: text('error'),
  // Set once the conversation has reported this background task's outcome or question.
  reportedAt: integer('reported_at', { mode: 'timestamp_ms' }),
  // Historical WorkLite-managed worktree evidence. New Chat project tasks let the executor
  // choose per-project Git operations and leave these fields empty.
  worktreePath: text('worktree_path'),
  worktreeBranch: text('worktree_branch'),
  baseBranch: text('base_branch'),
  baseCommit: text('base_commit'),
  mergeStatus: text('merge_status').$type<'not_attempted' | 'merging' | 'merged' | 'merged_cleanup_pending' | 'conflict' | 'skipped_not_git' | 'skipped_read_only'>().notNull().default('not_attempted'),
  mergeError: text('merge_error'),
  createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'),
}, (table) => [index('chat_codex_tasks_execution_idx').on(table.executionId)]);

// One-shot cross-conversation subscriptions to a project task's settlement report.
export const chatProjectTaskSubscriptions = sqliteTable('chat_project_task_subscriptions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull().references(() => chatProjectTasks.id, { onDelete: 'cascade' }),
  subscriberExecutionId: text('subscriber_execution_id').notNull().references(() => agentExecutions.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at'),
}, (table) => [uniqueIndex('chat_project_task_subscriptions_unique').on(table.taskId, table.subscriberExecutionId)]);

// Operation journal of tasks recorded before executors used native tools; retained as read-only evidence.
export const chatProjectOperations = sqliteTable('chat_codex_operations', {
  key: text('key').primaryKey(), taskId: text('task_id').notNull().references(() => chatProjectTasks.id, { onDelete: 'cascade' }),
  taskKey: text('task_key').notNull(), operationKey: text('operation_key').notNull(), toolName: text('tool_name').notNull(),
  inputFingerprint: text('input_fingerprint').notNull(),
  status: text('status').$type<'reserved' | 'completed' | 'uncertain' | 'failed'>().notNull(),
  commandId: text('command_id').references(() => commandExecutions.id, { onDelete: 'set null' }),
  result: text('result', { mode: 'json' }).$type<unknown>(), failureReason: text('failure_reason'),
  createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'),
}, (table) => [index('chat_codex_operations_task_idx').on(table.taskId)]);

// Image files referenced from Chat messages and task results; bytes live under <data>/chat-attachments/<id>.
// Conversation and task references are provenance only, so expiry rather than cascade owns removal.
export const chatAttachments = sqliteTable('chat_attachments', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  fileName: text('file_name').notNull(), mimeType: text('mime_type').notNull(), size: integer('size').notNull(),
  conversationId: text('conversation_id'), projectTaskId: text('project_task_id'),
  createdAt: timestamp('created_at'), expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [index('chat_attachments_expires_idx').on(table.expiresAt)]);

export const scheduledAgentTasks = sqliteTable('scheduled_agent_tasks', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }), label: text('label').notNull(), prompt: text('prompt').notNull(), intervalSeconds: integer('interval_seconds').notNull(), nextRunAt: timestamp('next_run_at'), activeExecutionId: text('active_execution_id'), lastRunAt: timestamp('last_run_at'), lastStatus: text('last_status').$type<'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled'>(), unread: integer('unread', { mode: 'boolean' }).notNull().default(false), running: integer('running', { mode: 'boolean' }).notNull().default(false), createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'),
}, (table) => [index('scheduled_agent_tasks_workspace_next_run_idx').on(table.workspaceId, table.nextRunAt)]);

export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), name: text('name').notNull(), endpoint: text('endpoint').notNull().default(''), connection: text('connection').$type<'connected' | 'unreachable' | 'auth_failed' | 'unconfigured'>().notNull().default('unconfigured'), connectionError: text('connection_error').$type<'authentication' | 'unreachable' | 'unsupported_protocol' | 'malformed_response'>(), transport: text('transport').notNull().default('Streamable HTTP'), allowedTools: integer('allowed_tools').notNull().default(0), allowedToolNames: text('allowed_tool_names', { mode: 'json' }).$type<string[]>().notNull().default([]), version: text('version').notNull().default('v1'), authSecret: text('auth_secret'), updatedAt: timestamp('updated_at'),
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
  | 'reviewer'
  | 'worktree-manager'
  | 'team-manager'
  | (string & {});

export type StoredAgentTeamMode = 'plan_only' | 'validate_existing' | 'implement_and_validate';

export type StoredAgentTeamOperationRecoveryDecision =
  | { type: 'adopt_command' }
  | { type: 'mark_failed' }
  | { type: 'replay'; replayOperationKey: string };

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

export type StoredAgentTeamProjectInstructionFile = {
  path: string;
  content: string;
};

export type StoredAgentTeamDeveloperInstanceConfiguration = {
  developerId: string;
  label: string;
  publicModelId: string;
  instructions: string;
  entryPoints: string[];
  processReferences?: string[];
  skills: StoredAgentTeamSkillSnapshot[];
  mcpServers: StoredAgentTeamMcpServerSnapshot[];
  toolNames: string[];
  executor?: StoredProjectExecutor;
};

export type StoredAgentTeamRoleConfiguration = {
  role: StoredAgentTeamRole;
  displayName?: string;
  publicModelId: string;
  instructions: string;
  entryPoints: string[];
  processReferences?: string[];
  skills: StoredAgentTeamSkillSnapshot[];
  mcpServers: StoredAgentTeamMcpServerSnapshot[];
  toolNames: string[];
  executor?: StoredProjectExecutor;
  developerInstances?: StoredAgentTeamDeveloperInstanceConfiguration[];
  developerConcurrency?: number;
};

export type StoredAgentTeamRecipeDefaults = {
  maxRepairRounds: number;
  maxDeveloperConcurrency?: number;
};

export type StoredAgentTeamVersionSnapshot = {
  processId: string;
  processVersion: string;
  developerExecution: StoredProjectExecutorLaunch | { kind: 'codex_app_server' };
  developerExecutions?: Record<string, StoredProjectExecutorLaunch | { kind: 'codex_app_server' }>;
  projectExecutorLaunches?: Record<string, StoredProjectExecutorLaunch | { kind: 'codex_app_server' }>;
  orchestrationVersion?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  workingPractice?: string;
  projectGitPolicy?: string;
  roles: StoredAgentTeamRoleConfiguration[];
  processFiles: Array<{ path: string; content: string }>;
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
  workingPractice: text('working_practice').notNull().default(''),
  projectGitPolicy: text('project_git_policy').notNull().default(''),
  // Maximum number of simultaneously active Runs for this Team; dispatches
  // beyond it persist as queued Runs and start FIFO when a slot frees.
  maxConcurrentRuns: integer('max_concurrent_runs').notNull().default(3),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
}, (table) => [unique().on(table.workspaceId, table.name)]);

export const agentTeamRepositories = sqliteTable('agent_team_repositories', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull().references(() => agentTeams.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  directory: text('directory').notNull(),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
}, (table) => [unique().on(table.teamId, table.directory)]);

export const agentTeamGroups = sqliteTable('agent_team_groups', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull().references(() => agentTeams.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default(''),
  mode: text('mode').$type<StoredAgentTeamMode>().notNull().default('implement_and_validate'),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
}, (table) => [index('agent_team_groups_workspace_updated_idx').on(table.workspaceId, table.updatedAt)]);

export const agentTeamGroupRepositories = sqliteTable('agent_team_group_repositories', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  groupId: text('group_id').notNull().references(() => agentTeamGroups.id, { onDelete: 'cascade' }),
  teamRepositoryId: text('team_repository_id').notNull().references(() => agentTeamRepositories.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  directory: text('directory').notNull(),
  createdAt: timestamp('created_at'),
}, (table) => [unique().on(table.groupId, table.directory), index('agent_team_group_repositories_group_idx').on(table.groupId)]);

export type StoredAgentTeamGroupMessageKind = 'text' | 'question' | 'handoff' | 'control' | 'status' | 'file';

export const agentTeamGroupMessages = sqliteTable('agent_team_group_messages', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  groupId: text('group_id').notNull().references(() => agentTeamGroups.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  sender: text('sender').$type<'user' | 'role' | 'system'>().notNull(),
  senderRole: text('sender_role').$type<StoredAgentTeamRole>(),
  recipientRole: text('recipient_role').$type<StoredAgentTeamRole>(),
  kind: text('kind').$type<StoredAgentTeamGroupMessageKind>().notNull().default('text'),
  body: text('body').notNull(),
  runId: text('run_id').references((): AnySQLiteColumn => agentTeamRuns.id, { onDelete: 'set null' }),
  taskAttemptId: text('task_attempt_id').references((): AnySQLiteColumn => agentTeamTaskAttempts.id, { onDelete: 'set null' }),
  repositoryIds: text('repository_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  fileReferences: text('file_references', { mode: 'json' }).$type<Array<{ documentId: string; revision: number; title: string }>>().notNull().default([]),
  submissionId: text('submission_id'),
  deliveryStatus: text('delivery_status').$type<'pending' | 'delivered' | 'failed'>().notNull().default('delivered'),
  createdAt: timestamp('created_at'),
}, (table) => [
  unique().on(table.groupId, table.sequence),
  unique().on(table.groupId, table.submissionId),
  unique().on(table.taskAttemptId),
  index('agent_team_group_messages_run_idx').on(table.runId),
]);

export const agentTeamGroupEvents = sqliteTable('agent_team_group_events', {
  groupId: text('group_id').notNull().references(() => agentTeamGroups.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  type: text('type').$type<'message' | 'repository.updated' | 'run.updated' | 'memory.updated'>().notNull(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at'),
}, (table) => [primaryKey({ columns: [table.groupId, table.sequence] })]);

export const agentTeamMemories = sqliteTable('agent_team_memories', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull().references(() => agentTeams.id, { onDelete: 'cascade' }),
  repositoryId: text('repository_id').references(() => agentTeamRepositories.id, { onDelete: 'cascade' }),
  role: text('role').$type<StoredAgentTeamRole>(),
  content: text('content').notNull(),
  sourceMessageId: text('source_message_id').references(() => agentTeamGroupMessages.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
}, (table) => [index('agent_team_memories_scope_idx').on(table.teamId, table.repositoryId, table.role, table.updatedAt)]);


export type StoredAgentTeamIntakeStatus = 'queued' | 'collecting' | 'starting' | 'started' | 'failed';

export const agentTeamConversations = sqliteTable('agent_team_conversations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull().references(() => agentTeams.id, { onDelete: 'cascade' }),
  latestProjectDirectory: text('latest_project_directory'),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
}, (table) => [unique().on(table.workspaceId, table.teamId)]);

export const agentTeamIntakes = sqliteTable('agent_team_intakes', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').notNull().references(() => agentTeamConversations.id, { onDelete: 'cascade' }),
  submissionId: text('submission_id').notNull(),
  goal: text('goal'),
  projectDirectory: text('project_directory'),
  mode: text('mode').$type<StoredAgentTeamMode>(),
  unresolvedField: text('unresolved_field').$type<'goal' | 'projectDirectory' | 'mode'>(),
  status: text('status').$type<StoredAgentTeamIntakeStatus>().notNull().default('collecting'),
  runId: text('run_id').references(() => agentTeamRuns.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
}, (table) => [
  unique().on(table.conversationId, table.submissionId),
  index('agent_team_intakes_conversation_status_idx').on(table.conversationId, table.status),
]);

export const agentTeamConversationMessages = sqliteTable('agent_team_conversation_messages', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').notNull().references(() => agentTeamConversations.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  intakeId: text('intake_id').references(() => agentTeamIntakes.id, { onDelete: 'set null' }),
  runId: text('run_id').references(() => agentTeamRuns.id, { onDelete: 'set null' }),
  speaker: text('speaker').$type<'user' | 'coordinator' | 'member' | 'system'>().notNull(),
  kind: text('kind').$type<'task_request' | 'coordinator_question' | 'answer' | 'run_answer' | 'note' | 'member_question' | 'status' | 'file_delivery' | 'delivery_failed' | 'run_state'>().notNull(),
  payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
  deduplicationKey: text('deduplication_key'),
  createdAt: timestamp('created_at'),
}, (table) => [
  primaryKey({ columns: [table.conversationId, table.sequence] }),
  unique().on(table.conversationId, table.deduplicationKey),
  index('agent_team_conversation_messages_run_idx').on(table.runId),
]);

export const agentTeamConversationEvents = sqliteTable('agent_team_conversation_events', {
  conversationId: text('conversation_id').notNull().references(() => agentTeamConversations.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  type: text('type').$type<'message' | 'intake.updated' | 'run.state'>().notNull(),
  payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
  createdAt: timestamp('created_at'),
}, (table) => [primaryKey({ columns: [table.conversationId, table.sequence] })]);

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
  groupId: text('group_id').references(() => agentTeamGroups.id, { onDelete: 'set null' }),
  groupMessageId: text('group_message_id').references((): AnySQLiteColumn => agentTeamGroupMessages.id, { onDelete: 'set null' }),
  targetRole: text('target_role').$type<StoredAgentTeamRole>(),
  repositoryIds: text('repository_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  groupContext: text('group_context', { mode: 'json' }).$type<{
    groupId: string;
    initialMessageId: string;
    initialMessage: string;
    targetRole: StoredAgentTeamRole;
    mode: StoredAgentTeamMode;
    repositories: Array<{ id: string; memoryRepositoryId: string; name: string; directory: string; projectInstructions: StoredAgentTeamProjectInstructionFile[] }>;
    knownRepositories?: Array<{ name: string; directory: string }>;
    memories: Array<{ id: string; repositoryId: string | null; role: StoredAgentTeamRole | null; content: string }>;
  }>(),
  status: text('status').$type<'queued' | 'running' | 'waiting_for_input' | 'paused' | 'succeeded' | 'failed' | 'cancelled'>().notNull().default('queued'),
  intent: text('intent').notNull(),
  projectDirectory: text('project_directory').notNull(),
  projectInstructions: text('project_instructions', { mode: 'json' }).$type<StoredAgentTeamProjectInstructionFile[]>().notNull().default([]),
  mode: text('mode').$type<StoredAgentTeamMode>().notNull(),
  authorizedCommands: text('authorized_commands', { mode: 'json' }).$type<string[]>().notNull().default([]),
  scopeRevision: integer('scope_revision').notNull().default(1),
  desiredControlState: text('desired_control_state').$type<'none' | 'pause_requested' | 'cancel_requested'>().notNull().default('none'),
  langGraphThreadId: text('lang_graph_thread_id').notNull().unique(),
  outcome: text('outcome', { mode: 'json' }).$type<unknown>(),
  // Run-level worktree evidence written by the Worktree Manager stage
  // (orchestration v4); retained on conflict, failure, or interruption.
  worktreeBasePath: text('worktree_base_path'),
  runBranch: text('run_branch'),
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
  developerId: text('developer_id'),
  assignmentTitle: text('assignment_title'),
  status: text('status').$type<'running' | 'waiting_for_input' | 'waiting_for_recovery' | 'completed' | 'failed' | 'cancelled'>().notNull().default('running'),
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
  deliveryStatus: text('delivery_status').$type<'pending' | 'delivered' | 'failed'>().notNull().default('pending'),
  deliveryError: text('delivery_error'),
  createdAt: timestamp('created_at'),
}, (table) => [
  unique().on(table.runId, table.key, table.revision),
  index('agent_team_documents_run_idx').on(table.runId, table.createdAt),
]);

export const agentTeamRunEvents = sqliteTable('agent_team_run_events', {
  runId: text('run_id').notNull().references(() => agentTeamRuns.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  type: text('type').$type<'run.status' | 'task.started' | 'task.activity' | 'task.delta' | 'task.waiting' | 'task.completed' | 'task.failed' | 'document.committed' | 'document.delivered' | 'document.delivery_failed' | 'operation.updated' | 'input.requested' | 'input.answered' | 'run.outcome' | 'run.progress'>().notNull(),
  payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
  createdAt: timestamp('created_at'),
}, (table) => [primaryKey({ columns: [table.runId, table.sequence] })]);

export const agentTeamPendingInputs = sqliteTable('agent_team_pending_inputs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull().references(() => agentTeamRuns.id, { onDelete: 'cascade' }),
  taskAttemptId: text('task_attempt_id').notNull().references(() => agentTeamTaskAttempts.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<'question' | 'operation_recovery'>().notNull().default('question'),
  question: text('question').notNull(),
  operationKey: text('operation_key'),
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
  recoveryDecision: text('recovery_decision', { mode: 'json' }).$type<StoredAgentTeamOperationRecoveryDecision>(),
  recoveryDecidedAt: integer('recovery_decided_at', { mode: 'timestamp_ms' }),
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
export type AgentTeamGroup = typeof agentTeamGroups.$inferSelect;
export type AgentTeamRepository = typeof agentTeamRepositories.$inferSelect;
export type AgentTeamGroupRepository = typeof agentTeamGroupRepositories.$inferSelect;
export type AgentTeamGroupMessage = typeof agentTeamGroupMessages.$inferSelect;
export type AgentTeamGroupEvent = typeof agentTeamGroupEvents.$inferSelect;
export type AgentTeamMemory = typeof agentTeamMemories.$inferSelect;
export type AgentTeamVersion = typeof agentTeamVersions.$inferSelect;
export type AgentTeamConversation = typeof agentTeamConversations.$inferSelect;
export type AgentTeamIntake = typeof agentTeamIntakes.$inferSelect;
export type AgentTeamConversationMessage = typeof agentTeamConversationMessages.$inferSelect;
export type AgentTeamConversationEvent = typeof agentTeamConversationEvents.$inferSelect;
export type AgentTeamRun = typeof agentTeamRuns.$inferSelect;
export type AgentTeamTaskAttempt = typeof agentTeamTaskAttempts.$inferSelect;
export type AgentTeamDocument = typeof agentTeamDocuments.$inferSelect;
export type AgentTeamRunEvent = typeof agentTeamRunEvents.$inferSelect;
export type AgentTeamPendingInput = typeof agentTeamPendingInputs.$inferSelect;
export type AgentTeamOperation = typeof agentTeamOperations.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type ChatMemory = typeof chatMemories.$inferSelect;
