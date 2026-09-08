import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`);

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(), slug: text('slug').notNull().unique(), name: text('name').notNull(), createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'),
});

export const workspaceSettings = sqliteTable('workspace_settings', {
  workspaceId: text('workspace_id').primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  appearance: text('appearance').$type<'system' | 'light' | 'dark'>().notNull().default('system'),
  locale: text('locale').$type<'en' | 'zh-CN'>().notNull().default('en'),
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

export type StoredWorkflowEdge = {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
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
  schemaVersion: 3,
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

export const workflowRuns = sqliteTable('workflow_runs', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }), workflowVersionId: text('workflow_version_id').notNull().references(() => workflowVersions.id, { onDelete: 'restrict' }),
  status: text('status').$type<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>().notNull().default('queued'), input: text('input', { mode: 'json' }).$type<unknown>().notNull(), result: text('result', { mode: 'json' }).$type<unknown>(), currentNodeId: text('current_node_id'),
  createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'), finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
});

export const workflowNodeRuns = sqliteTable('workflow_node_runs', {
  id: text('id').primaryKey(), runId: text('run_id').notNull().references(() => workflowRuns.id, { onDelete: 'cascade' }), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), nodeId: text('node_id').notNull(), position: integer('position').notNull(), type: text('type').notNull(), typeVersion: text('type_version').notNull(), status: text('status').$type<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'>().notNull().default('queued'), input: text('input', { mode: 'json' }).$type<unknown>(), output: text('output', { mode: 'json' }).$type<unknown>(), artifactIds: text('artifact_ids', { mode: 'json' }).$type<string[]>().notNull().default([]), error: text('error'), retryCount: integer('retry_count').notNull().default(0), startedAt: integer('started_at', { mode: 'timestamp_ms' }), finishedAt: integer('finished_at', { mode: 'timestamp_ms' }), createdAt: timestamp('created_at'),
});

export const workflowRunEvents = sqliteTable('workflow_run_events', {
  runId: text('run_id').notNull().references(() => workflowRuns.id, { onDelete: 'cascade' }), sequence: integer('sequence').notNull(), type: text('type').$type<'run.status' | 'node.started' | 'node.delta' | 'node.completed' | 'node.failed' | 'artifact.created'>().notNull(), payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(), createdAt: timestamp('created_at'),
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
  | { type: 'resource'; resourceType: 'provider' | 'agent' | 'skill' | 'mcp-server' | 'workflow'; id: string; route: string }
  | { type: 'navigation'; target: 'home' | 'agents' | 'system-helper-chat' | 'skills' | 'mcp-servers' | 'model-providers' | 'workflows' | 'runs' | 'artifacts' | 'settings-appearance' | 'settings-usage' | 'settings-audit-log'; route: string }
  | { type: 'settings'; appearance: 'system' | 'light' | 'dark'; locale: 'en' | 'zh-CN' }
  | { type: 'snapshot' };

export const agentExecutions = sqliteTable('agent_executions', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }), status: text('status').$type<'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled'>().notNull().default('running'), phase: text('phase').$type<'model' | 'skill' | 'recovery'>().notNull().default('model'), errorCode: text('error_code').$type<'provider' | 'invalid_request' | 'invalid_tool_request' | 'incomplete_tool_request' | 'skill' | 'mcp' | 'restarted' | 'internal'>(), modelMessages: text('model_messages', { mode: 'json' }).$type<StoredAgentModelMessage[]>().notNull().default([]), displayMessages: text('display_messages', { mode: 'json' }).$type<StoredAgentDisplayMessage[]>().notNull().default([]), plan: text('plan', { mode: 'json' }).$type<StoredAgentPlanStep[]>().notNull().default([]), pendingQuestion: text('pending_question', { mode: 'json' }).$type<StoredAgentPendingQuestion | null>(), contextDropped: integer('context_dropped').notNull().default(0), error: text('error'), createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'),
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

export const modelProviders = sqliteTable('model_providers', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), name: text('name').notNull(), baseURL: text('base_url'), protocol: text('protocol').$type<'openai/chat' | 'openai/responses' | 'codex/responses' | 'deepseek/chat'>().notNull().default('openai/chat'), status: text('status').$type<'connected' | 'unconfigured' | 'invalid'>().notNull().default('unconfigured'), maskedKey: text('masked_key').notNull().default(''), models: text('models', { mode: 'json' }).$type<string[]>().notNull().default([]), apiKey: text('api_key'), headers: text('headers'), updatedAt: timestamp('updated_at'),
});

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), workflowId: text('workflow_id').references(() => workflows.id, { onDelete: 'set null' }), runId: text('run_id').references(() => workflowRuns.id, { onDelete: 'set null' }), name: text('name').notNull(), type: text('type').$type<'json' | 'text' | 'markdown' | 'unsupported'>().notNull(), size: text('size').notNull().default('0 B'), content: text('content').notNull().default(''), objectKey: text('object_key'), createdAt: timestamp('created_at'),
});

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), actorId: text('actor_id'), action: text('action').notNull(), resource: text('resource').notNull(), metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}), createdAt: timestamp('created_at'),
});

export const diagnosticLogs = sqliteTable('diagnostic_logs', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), traceId: text('trace_id').notNull(), providerId: text('provider_id'), operation: text('operation').notNull(), stage: text('stage').notNull(), level: text('level').$type<'debug' | 'info' | 'warn' | 'error'>().notNull(), status: text('status').$type<'started' | 'succeeded' | 'failed'>().notNull(), message: text('message').notNull(), durationMs: integer('duration_ms'), metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}), createdAt: timestamp('created_at'),
});

export type Workspace = typeof workspaces.$inferSelect;
export type Plugin = typeof plugins.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type AgentVersion = typeof agentVersions.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type WorkflowDraft = typeof workflowDrafts.$inferSelect;
export type WorkflowEditRevision = typeof workflowEditRevisions.$inferSelect;
export type WorkflowVersion = typeof workflowVersions.$inferSelect;
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
export type Artifact = typeof artifacts.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type DiagnosticLog = typeof diagnosticLogs.$inferSelect;
