import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), kind: text('kind').$type<'system' | 'custom'>().notNull().default('custom'), name: text('name').notNull(), responsibility: text('responsibility').notNull(), model: text('model').notNull(), providerId: text('provider_id'),
  systemPrompt: text('system_prompt').notNull().default(''), createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'),
});

export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), name: text('name').notNull(), state: text('state').$type<'draft' | 'published'>().notNull().default('draft'), createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'),
});

export const workflowVersions = sqliteTable('workflow_versions', {
  id: text('id').primaryKey(), workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }), version: integer('version').notNull().default(1), published: integer('published', { mode: 'boolean' }).notNull().default(false),
  steps: text('steps', { mode: 'json' }).$type<Array<{ agentId: string; position: number }>>().notNull().default([]), createdAt: timestamp('created_at'),
});

export const workflowRuns = sqliteTable('workflow_runs', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }), workflowVersionId: text('workflow_version_id').notNull().references(() => workflowVersions.id, { onDelete: 'restrict' }),
  status: text('status').$type<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>().notNull().default('queued'), input: text('input', { mode: 'json' }).$type<unknown>().notNull(), result: text('result', { mode: 'json' }).$type<unknown>(), currentNodeId: text('current_node_id'),
  createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'), finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
});

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

export type StoredWorkliteScriptResult =
  | { type: 'resource'; resourceType: 'provider' | 'agent' | 'skill' | 'mcp-server' | 'workflow'; id: string; route: string }
  | { type: 'navigation'; target: 'home' | 'agents' | 'system-helper-chat' | 'skills' | 'mcp-servers' | 'model-providers' | 'workflows' | 'runs' | 'artifacts' | 'settings-appearance' | 'settings-usage' | 'settings-audit-log'; route: string }
  | { type: 'settings'; appearance: 'system' | 'light' | 'dark'; locale: 'en' | 'zh-CN' }
  | { type: 'snapshot' };

export const agentExecutions = sqliteTable('agent_executions', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }), status: text('status').$type<'running' | 'completed' | 'failed' | 'cancelled'>().notNull().default('running'), modelMessages: text('model_messages', { mode: 'json' }).$type<StoredAgentModelMessage[]>().notNull().default([]), displayMessages: text('display_messages', { mode: 'json' }).$type<StoredAgentDisplayMessage[]>().notNull().default([]), error: text('error'), createdAt: timestamp('created_at'), updatedAt: timestamp('updated_at'),
});

export const agentToolCalls = sqliteTable('agent_tool_calls', {
  id: text('id').primaryKey(), executionId: text('execution_id').notNull().references(() => agentExecutions.id, { onDelete: 'cascade' }), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }), toolCallId: text('tool_call_id').notNull(), toolName: text('tool_name').$type<'skill_script'>().notNull(), workingDirectory: text('working_directory').notNull(), skillId: text('skill_id'), skillName: text('skill_name'), scriptPath: text('script_path'), arguments: text('arguments', { mode: 'json' }).$type<string[]>().notNull().default([]), packageFiles: text('package_files', { mode: 'json' }).$type<Array<{ path: string; content: string }>>().notNull().default([]), commandExecutionId: text('command_execution_id').references(() => commandExecutions.id, { onDelete: 'set null' }), status: text('status').$type<'running' | 'completed' | 'failed' | 'cancelled'>().notNull().default('running'), output: text('output').notNull().default(''), result: text('result', { mode: 'json' }).$type<StoredWorkliteScriptResult>(), exitCode: integer('exit_code'), resultAppended: integer('result_appended', { mode: 'boolean' }).notNull().default(false), createdAt: timestamp('created_at'), finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
});

export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), name: text('name').notNull(), endpoint: text('endpoint').notNull().default(''), connection: text('connection').$type<'connected' | 'unreachable' | 'auth_failed' | 'unconfigured'>().notNull().default('unconfigured'), transport: text('transport').notNull().default('Streamable HTTP'), allowedTools: integer('allowed_tools').notNull().default(0), version: text('version').notNull().default('v1'), authSecret: text('auth_secret'), updatedAt: timestamp('updated_at'),
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
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), name: text('name').notNull(), kind: text('kind').$type<'deepseek' | 'openai' | 'openai-compatible'>().notNull().default('openai-compatible'), baseUrl: text('base_url'), organization: text('organization'), project: text('project'), status: text('status').$type<'connected' | 'unconfigured' | 'invalid'>().notNull().default('unconfigured'), maskedKey: text('masked_key').notNull().default(''), models: text('models', { mode: 'json' }).$type<string[]>().notNull().default([]), apiKey: text('api_key'), headers: text('headers'), updatedAt: timestamp('updated_at'),
});

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), workflowId: text('workflow_id').references(() => workflows.id, { onDelete: 'set null' }), runId: text('run_id').references(() => workflowRuns.id, { onDelete: 'set null' }), name: text('name').notNull(), type: text('type').$type<'json' | 'text' | 'markdown' | 'unsupported'>().notNull(), size: text('size').notNull().default('0 B'), content: text('content').notNull().default(''), objectKey: text('object_key'), createdAt: timestamp('created_at'),
});

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), actorId: text('actor_id'), action: text('action').notNull(), resource: text('resource').notNull(), metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}), createdAt: timestamp('created_at'),
});

export type Workspace = typeof workspaces.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type WorkflowVersion = typeof workflowVersions.$inferSelect;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type CommandExecution = typeof commandExecutions.$inferSelect;
export type CommandExecutionEvent = typeof commandExecutionEvents.$inferSelect;
export type Skill = typeof skills.$inferSelect;
export type SkillFile = typeof skillFiles.$inferSelect;
export type AgentExecution = typeof agentExecutions.$inferSelect;
export type AgentToolCall = typeof agentToolCalls.$inferSelect;
export type McpServer = typeof mcpServers.$inferSelect;
export type ModelProvider = typeof modelProviders.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
