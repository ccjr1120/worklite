import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

const TERMINAL_COMMAND_SKILL_MD = `# terminal-command

Use \`scripts/run.sh\` only when a Unix shell command directly advances the user request.

Pass exactly one argument containing the complete command string. Do not split the command into multiple arguments. The script delegates to /bin/sh -lc in the API process working directory with the WorkLite process user host permissions and complete environment. Every valid Agent script call executes immediately without browser approval. Never include secrets in a command and never claim execution until the script result is returned.`;

const TERMINAL_COMMAND_RUN_SH = `#!/bin/sh
set -eu

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: run.sh <command>" >&2
  exit 64
fi

exec /bin/sh -lc "$1"
`;

const SYSTEM_HELPER_PROMPT = `You are System Helper Chat, the WorkLite workspace setup assistant.
Use only assigned Skill scripts for platform inspection and operations. Never invent configured resources, models, MCP tools, script results, or platform capabilities.
Never ask the user to paste API keys, tokens, passwords, or other secrets into conversation or script arguments. Provider credentials must be entered in the dedicated secure form.
Before claiming a platform operation completed, wait for the script result. Keep responses concise and practical.`;

const WORKLITE_PLATFORM_SKILL_MD = `# worklite-platform

Use the exact scripts in this package for WorkLite platform operations.

Use \`scripts/inspect-workspace.mjs\` before answering questions about configured resources. Creation, settings, and navigation scripts accept exactly one JSON object argument. Every valid Agent script call executes immediately without browser approval. Provider scripts never accept credentials; direct the user to the secure Provider form after creation.

Never call arbitrary URLs, access the database directly, delete resources, invoke terminal execution, or claim completion before the script result is returned. See \`references/contracts.md\` for input shapes.`;

const WORKLITE_PLATFORM_LIB_MJS = `const baseUrl = process.env.WORKLITE_API_URL;
if (!baseUrl) throw new Error('WORKLITE_API_URL is unavailable.');

export function input(required = true) {
  if (process.argv.length > 3) throw new Error('Exactly one JSON object argument is allowed.');
  const value = process.argv[2];
  if (!value) {
    if (!required) return {};
    throw new Error('One JSON object argument is required.');
  }
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The script argument must be a JSON object.');
  return parsed;
}

export function noInput() {
  if (process.argv.length !== 2) throw new Error('This script does not accept arguments.');
}

export function exactKeys(value, allowed) {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected) throw new Error('Unsupported input field: ' + unexpected);
}

export function requiredString(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(field + ' must be a non-empty string no longer than ' + maxLength + ' characters.');
  return value.trim();
}

export function boundedString(value, field, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(field + ' must be a string no longer than ' + maxLength + ' characters.');
  return value.trim();
}

export function stringValue(value, field) {
  if (typeof value !== 'string') throw new Error(field + ' must be a string.');
  return value.trim();
}

export function text(value, field, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(field + ' must be text no longer than ' + maxLength + ' characters.');
  return value;
}

export function nullableString(value, field, maxLength) {
  return value === null ? null : requiredString(value, field, maxLength);
}

export function optionalString(value, field, maxLength) {
  return value === undefined ? undefined : boundedString(value, field, maxLength);
}

export function oneOf(value, field, values) {
  if (!values.includes(value)) throw new Error(field + ' has an unsupported value.');
  return value;
}

export function stringArray(value, field, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > maxLength)) throw new Error(field + ' must be an array of non-empty strings.');
  return [...new Set(value.map((item) => item.trim()))];
}

export function packageFiles(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error('files must be a non-empty package file array.');
  return value.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('Every package file must be an object.');
    exactKeys(file, ['path', 'content']);
    return { path: requiredString(file.path, 'file path', 240), content: text(file.content, 'file content', 262144) };
  });
}

export async function call(path, options = {}) {
  const response = await fetch(baseUrl + path, {
    method: options.method || 'GET',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let value = null;
  if (text) {
    try { value = JSON.parse(text); } catch { value = { message: text }; }
  }
  if (!response.ok) throw new Error(value && typeof value.message === 'string' ? value.message : 'WorkLite API request failed.');
  return value;
}

export function print(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}
`;

const WORKLITE_PLATFORM_FILES: Array<[string, string]> = [
  ['SKILL.md', WORKLITE_PLATFORM_SKILL_MD],
  ['scripts/lib.mjs', WORKLITE_PLATFORM_LIB_MJS],
  ['scripts/inspect-workspace.mjs', `#!/usr/bin/env node
import { call, noInput, print } from './lib.mjs';
noInput();
const data = await call('/platform/snapshot');
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/create-provider.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, optionalString, print, requiredString, stringArray } from './lib.mjs';
const raw = input();
exactKeys(raw, ['name', 'protocol', 'baseURL', 'models']);
const body = { name: requiredString(raw.name, 'name', 120), protocol: oneOf(raw.protocol, 'protocol', ['openai/chat', 'openai/responses', 'deepseek/chat']), baseURL: requiredString(raw.baseURL, 'baseURL', 2048), models: stringArray(raw.models, 'models', 100, 200) };
for (const [field, maxLength] of [['baseURL', 2048]]) {
  const value = optionalString(raw[field], field, maxLength);
  if (value !== undefined) body[field] = value;
}
const resource = await call('/portkey-gateway/providers', { method: 'POST', body });
print({ worklite: { type: 'resource', resourceType: 'provider', id: resource.id, route: '/model-providers' }, data: resource });
`],
  ['scripts/create-agent.mjs', `#!/usr/bin/env node
import { boundedString, call, exactKeys, input, nullableString, print, requiredString, stringArray, stringValue } from './lib.mjs';
const raw = input();
exactKeys(raw, ['name', 'responsibility', 'systemPrompt', 'providerId', 'model', 'skillIds', 'mcpServerIds']);
const body = { name: requiredString(raw.name, 'name', 120), responsibility: stringValue(raw.responsibility, 'responsibility'), systemPrompt: stringValue(raw.systemPrompt, 'systemPrompt'), providerId: nullableString(raw.providerId, 'providerId', 200), model: boundedString(raw.model, 'model', 200), skillIds: stringArray(raw.skillIds, 'skillIds', 100, 200), mcpServerIds: stringArray(raw.mcpServerIds, 'mcpServerIds', 100, 200) };
const resource = await call('/agents', { method: 'POST', body });
print({ worklite: { type: 'resource', resourceType: 'agent', id: resource.id, route: '/agents/' + encodeURIComponent(resource.id) }, data: resource });
`],
  ['scripts/create-skill.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, packageFiles, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['name', 'source', 'files']);
const body = { name: requiredString(raw.name, 'name', 120), source: oneOf(raw.source, 'source', ['online']), files: packageFiles(raw.files) };
const resource = await call('/skills', { method: 'POST', body });
print({ worklite: { type: 'resource', resourceType: 'skill', id: resource.id, route: '/skills/' + encodeURIComponent(resource.id) }, data: resource });
`],
  ['scripts/create-mcp-server.mjs', `#!/usr/bin/env node
import { boundedString, call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['name', 'endpoint']);
const body = { name: requiredString(raw.name, 'name', 120), endpoint: boundedString(raw.endpoint, 'endpoint', 2048) };
const resource = await call('/mcp-servers', { method: 'POST', body });
print({ worklite: { type: 'resource', resourceType: 'mcp-server', id: resource.id, route: '/mcp-servers/' + encodeURIComponent(resource.id) }, data: resource });
`],
  ['scripts/create-workflow.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['name']);
const resource = await call('/workflows', { method: 'POST', body: { name: requiredString(raw.name, 'name', 120) } });
print({ worklite: { type: 'resource', resourceType: 'workflow', id: resource.id, route: '/workflows/' + encodeURIComponent(resource.id) }, data: resource });
`],
  ['scripts/update-settings.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, print } from './lib.mjs';
const raw = input();
exactKeys(raw, ['appearance', 'locale']);
const body = {};
if ('appearance' in raw) body.appearance = oneOf(raw.appearance, 'appearance', ['system', 'light', 'dark']);
if ('locale' in raw) body.locale = oneOf(raw.locale, 'locale', ['en', 'zh-CN']);
if (Object.keys(body).length === 0) throw new Error('At least one setting is required.');
const settings = await call('/settings', { method: 'PATCH', body });
print({ worklite: { type: 'settings', appearance: settings.appearance, locale: settings.locale }, data: settings });
`],
  ['scripts/navigate.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, print } from './lib.mjs';
const raw = input();
exactKeys(raw, ['target']);
const target = oneOf(raw.target, 'target', ['home', 'agents', 'system-helper-chat', 'skills', 'mcp-servers', 'model-providers', 'workflows', 'runs', 'artifacts', 'settings-appearance', 'settings-usage', 'settings-audit-log']);
const action = await call('/navigation/resolve', { method: 'POST', body: { target } });
print({ worklite: action });
`],
  ['references/contracts.md', `# WorkLite platform script contracts

- inspect-workspace.mjs: no arguments
- create-provider.mjs: { "name": string, "protocol": "openai/chat" | "openai/responses" | "deepseek/chat", "baseURL": string, "models": string[] }
- create-agent.mjs: { "name": string, "responsibility": string, "systemPrompt": string, "providerId": string | null, "model": string, "skillIds": string[], "mcpServerIds": string[] }
- create-skill.mjs: { "name": string, "source": "online", "files": [{ "path": string, "content": string }] }
- create-mcp-server.mjs: { "name": string, "endpoint": string }
- create-workflow.mjs: { "name": string }
- update-settings.mjs: { "appearance"?: "system" | "light" | "dark", "locale"?: "en" | "zh-CN" }
- navigate.mjs: { "target": "home" | "agents" | "system-helper-chat" | "skills" | "mcp-servers" | "model-providers" | "workflows" | "runs" | "artifacts" | "settings-appearance" | "settings-usage" | "settings-audit-log" }
`],
];

export function createDb(filePath: string) {
  const path = filePath === ':memory:' ? filePath : (isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath));
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const client = new BetterSqlite3(path);
  client.pragma('foreign_keys = ON');
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;

export async function initializeDatabase(db: Database): Promise<void> {
  const migrationsFolder = [
    resolve(process.cwd(), 'packages/db/drizzle'),
    resolve(process.cwd(), '../../packages/db/drizzle'),
  ].find((candidate) => existsSync(candidate));
  if (!migrationsFolder) throw new Error('Drizzle migrations folder could not be located.');
  migrate(db, { migrationsFolder });

  const workflowRows = db.$client.prepare('SELECT id, workspace_id FROM workflows').all() as Array<{ id: string; workspace_id: string }>;
  const workflowVersionQuery = db.$client.prepare(`
    SELECT id, nodes, definition, schema_version
    FROM workflow_versions
    WHERE workflow_id = ?
    ORDER BY published ASC, version DESC
    LIMIT 1
  `);
  const draftInsert = db.$client.prepare(`
    INSERT OR IGNORE INTO workflow_drafts (id, workspace_id, workflow_id, current_revision_id, definition)
    VALUES (?, ?, ?, ?, ?)
  `);
  const revisionInsert = db.$client.prepare(`
    INSERT OR IGNORE INTO workflow_edit_revisions (id, workspace_id, workflow_id, draft_id, parent_revision_id, source, source_instruction, operations, snapshot)
    VALUES (?, ?, ?, ?, NULL, 'migration', 'Imported from the legacy workflow version snapshot.', '[]', ?)
  `);
  const versionDefinitionUpdate = db.$client.prepare('UPDATE workflow_versions SET definition = COALESCE(definition, ?), published_at = CASE WHEN published = 1 AND published_at IS NULL THEN created_at ELSE published_at END WHERE id = ?');
  for (const workflow of workflowRows) {
    const draftId = `wfd_${workflow.id}`;
    const revisionId = `wfr_migration_${workflow.id}`;
    const existingDraft = db.$client.prepare('SELECT id FROM workflow_drafts WHERE workflow_id = ? LIMIT 1').get(workflow.id) as { id: string } | undefined;
    if (existingDraft) continue;
    const version = workflowVersionQuery.get(workflow.id) as { id: string; nodes: string; definition: string | null; schema_version: number } | undefined;
    let definition = schema.emptyWorkflowDefinition;
    if (version?.definition) {
      try {
        definition = JSON.parse(version.definition) as typeof definition;
      } catch {
        definition = schema.emptyWorkflowDefinition;
      }
    } else if (version?.nodes) {
      try {
        definition = { ...schema.emptyWorkflowDefinition, schemaVersion: version.schema_version, nodes: JSON.parse(version.nodes) as schema.StoredWorkflowNode[] };
      } catch {
        definition = schema.emptyWorkflowDefinition;
      }
    }
    if (version) versionDefinitionUpdate.run(JSON.stringify(definition), version.id);
    draftInsert.run(draftId, workflow.workspace_id, workflow.id, revisionId, JSON.stringify(definition));
    revisionInsert.run(revisionId, workflow.workspace_id, workflow.id, draftId, JSON.stringify(definition));
  }

  const staleExecutions = db.$client.prepare(`
    SELECT id, workspace_id, agent_id,
      EXISTS (SELECT 1 FROM agent_sub_sessions WHERE agent_sub_sessions.execution_id = agent_executions.id) AS has_sub_session
    FROM agent_executions
    WHERE status = 'running'
  `).all() as Array<{ id: string; workspace_id: string; agent_id: string; has_sub_session: number }>;
  if (staleExecutions.length > 0) {
    db.$client.exec(`
      UPDATE agent_tool_calls
        SET status = 'failed', output = 'The API restarted before this Agent tool execution completed.', result_appended = 1, finished_at = unixepoch() * 1000
        WHERE status = 'running' AND execution_id IN (SELECT id FROM agent_executions WHERE status = 'running');
      UPDATE command_executions
        SET status = 'failed', signal = 'SIGHUP', finished_at = unixepoch() * 1000
        WHERE status IN ('queued', 'running', 'cancelling')
          AND id IN (SELECT command_execution_id FROM agent_tool_calls WHERE execution_id IN (SELECT id FROM agent_executions WHERE status = 'running'));
      UPDATE agent_executions
        SET status = 'failed', phase = 'recovery', error_code = 'restarted', error = 'The API restarted before this Agent turn completed.', updated_at = unixepoch() * 1000
        WHERE status = 'running';
      UPDATE agent_sub_sessions
        SET unread = 1, updated_at = unixepoch() * 1000
        WHERE execution_id IN (SELECT id FROM agent_executions WHERE error_code = 'restarted');
    `);
    for (const execution of staleExecutions) {
      db.insert(schema.auditLogs).values({
        id: `audit_${randomUUID()}`,
        workspaceId: execution.workspace_id,
        action: 'agent_execution.restarted',
        resource: execution.id,
        metadata: { agentId: execution.agent_id, executionId: execution.id, phase: 'recovery', errorCode: 'restarted', hasSubSession: Boolean(execution.has_sub_session) },
      }).run();
    }
  }

  const staleWorkflowRuns = db.$client.prepare(`
    SELECT id, workspace_id, workflow_id
    FROM workflow_runs
    WHERE status IN ('queued', 'running')
  `).all() as Array<{ id: string; workspace_id: string; workflow_id: string }>;
  if (staleWorkflowRuns.length > 0) {
    db.$client.exec(`
      UPDATE workflow_node_runs
        SET status = 'failed', error = 'The API restarted before this Workflow node completed.', finished_at = unixepoch() * 1000
        WHERE status IN ('queued', 'running')
          AND run_id IN (SELECT id FROM workflow_runs WHERE status IN ('queued', 'running'));
      INSERT INTO workflow_run_events (run_id, sequence, type, payload)
        SELECT workflow_runs.id,
          COALESCE((SELECT MAX(sequence) + 1 FROM workflow_run_events WHERE workflow_run_events.run_id = workflow_runs.id), 1),
          'run.status',
          '{"status":"failed","error":"The API restarted before this Workflow run completed."}'
        FROM workflow_runs
        WHERE status IN ('queued', 'running');
      UPDATE workflow_runs
        SET status = 'failed', current_node_id = NULL,
          result = '{"error":"The API restarted before this Workflow run completed."}',
          finished_at = unixepoch() * 1000, updated_at = unixepoch() * 1000
        WHERE status IN ('queued', 'running');
    `);
    for (const run of staleWorkflowRuns) {
      db.insert(schema.auditLogs).values({
        id: `audit_${randomUUID()}`,
        workspaceId: run.workspace_id,
        action: 'workflow_run.restarted',
        resource: run.id,
        metadata: { workflowId: run.workflow_id, runId: run.id, errorCode: 'restarted' },
      }).run();
    }
  }


  db.$client.exec(`
    DELETE FROM agents WHERE id = 'agt_agent_chat';
    INSERT INTO workspaces (id, slug, name) VALUES ('workspace_personal', 'personal', 'Personal Workspace') ON CONFLICT (slug) DO NOTHING;
    INSERT INTO workspace_settings (workspace_id) SELECT id FROM workspaces WHERE slug = 'personal' ON CONFLICT (workspace_id) DO NOTHING;
    INSERT INTO model_providers (id, workspace_id, name, protocol, status, masked_key, models)
      SELECT 'gateway-provider', workspaces.id, 'WorkLite Gateway Provider', 'openai/chat', 'connected', '', '[]'
      FROM workspaces WHERE workspaces.slug = 'personal'
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, protocol = excluded.protocol;
    INSERT INTO plugins (id, workspace_id, name, description, command)
      SELECT 'codex-cli-chat', workspaces.id, 'Codex CLI Chat', 'Chat with Codex CLI in the API workspace.', 'codex'
      FROM workspaces WHERE workspaces.slug = 'personal'
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description;
    INSERT INTO agents (id, workspace_id, kind, name, responsibility, system_prompt, model)
      SELECT 'agt_system_helper_chat', workspaces.id, 'system', 'System Helper Chat', 'Configure workspace AI resources through guided conversation', '${SYSTEM_HELPER_PROMPT.replaceAll("'", "''")}', ''
      FROM workspaces WHERE workspaces.slug = 'personal'
      ON CONFLICT (id) DO UPDATE SET kind = 'system', name = 'System Helper Chat', responsibility = 'Configure workspace AI resources through guided conversation', system_prompt = excluded.system_prompt;
    INSERT INTO agents (id, workspace_id, kind, name, responsibility, system_prompt, model)
      SELECT 'agt_codex_cli_chat', workspaces.id, 'system', 'Codex CLI Chat', 'Run conversations through the local Codex CLI', 'You are Codex CLI Chat. Answer the user request directly and concisely.', ''
      FROM workspaces WHERE workspaces.slug = 'personal'
      ON CONFLICT (id) DO UPDATE SET kind = 'system', name = 'Codex CLI Chat', responsibility = 'Run conversations through the local Codex CLI', system_prompt = 'You are Codex CLI Chat. Answer the user request directly and concisely.';
  `);

  const upsertBuiltInSkill = db.$client.prepare(`
    INSERT INTO skills (id, workspace_id, name, source, version, validation, instructions)
      SELECT ?, workspaces.id, ?, 'built-in', 'built-in', 'valid', ?
      FROM workspaces WHERE workspaces.slug = 'personal'
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, source = 'built-in', version = 'built-in', validation = 'valid', instructions = excluded.instructions
  `);
  upsertBuiltInSkill.run('sk_terminal_command', 'terminal-command', TERMINAL_COMMAND_SKILL_MD);
  upsertBuiltInSkill.run('sk_worklite_platform', 'worklite-platform', WORKLITE_PLATFORM_SKILL_MD);
  db.$client.exec(`
    INSERT INTO skill_files (skill_id, path, content)
      SELECT id, 'SKILL.md', instructions FROM skills WHERE true
      ON CONFLICT (skill_id, path) DO NOTHING;
    DELETE FROM skill_files WHERE skill_id IN ('sk_terminal_command', 'sk_worklite_platform');
    DELETE FROM agent_skills WHERE skill_id = 'sk_worklite_platform' AND agent_id <> 'agt_system_helper_chat';
    INSERT INTO agent_skills (agent_id, skill_id) VALUES ('agt_system_helper_chat', 'sk_worklite_platform') ON CONFLICT (agent_id, skill_id) DO NOTHING;
  `);
  const upsertBuiltInFile = db.$client.prepare(`
    INSERT INTO skill_files (skill_id, path, content) VALUES (?, 'SKILL.md', ?)
    ON CONFLICT (skill_id, path) DO UPDATE SET content = excluded.content
  `);
  upsertBuiltInFile.run('sk_terminal_command', TERMINAL_COMMAND_SKILL_MD);
  const upsertBuiltInScript = db.$client.prepare(`
    INSERT INTO skill_files (skill_id, path, content) VALUES (?, 'scripts/run.sh', ?)
    ON CONFLICT (skill_id, path) DO UPDATE SET content = excluded.content
  `);
  upsertBuiltInScript.run('sk_terminal_command', TERMINAL_COMMAND_RUN_SH);
  const upsertPlatformFile = db.$client.prepare(`
    INSERT INTO skill_files (skill_id, path, content) VALUES ('sk_worklite_platform', ?, ?)
    ON CONFLICT (skill_id, path) DO UPDATE SET content = excluded.content
  `);
  for (const file of WORKLITE_PLATFORM_FILES) upsertPlatformFile.run(...file);
}
