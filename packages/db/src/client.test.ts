import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, initializeDatabase, platformSkillPackageFiles } from './client';
import * as schema from './schema';
import type { Database } from './client';

let db: Database | undefined;

// Platform Skill files are written by workspace Skill reconciliation, not by
// initializeDatabase, so the packaged source is the authority under test.
function platformFile(path: string): { content: string } {
  const file = platformSkillPackageFiles().find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Platform Skill file ${path} is not packaged.`);
  return file;
}

afterEach(() => {
  db?.$client.close();
  db = undefined;
});

describe('initializeDatabase restart recovery', () => {
  it('publishes the protected local-image tool and synchronizes the seeded Chat prompt', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    const tools = JSON.parse(platformFile('scripts/tools.json').content);
    const tool = tools['scripts/upload-local-images.mjs'];
    expect(tool.name).toBe('upload_local_images');
    expect(tool.inputSchema).toMatchObject({ required: ['files'], additionalProperties: false, properties: {
      files: { type: 'array', minItems: 1, maxItems: 8, items: { required: ['path'], additionalProperties: false,
        properties: { path: { type: 'string', maxLength: 4096 }, description: { type: 'string', maxLength: 200 } } } },
    } });
    const description = tool.inputSchema.properties.files.items.properties.description;
    expect(new RegExp(description.pattern).test('首页截图')).toBe(true);
    for (const value of ['/tmp/private.png', 'a\\b', 'a\nb']) expect(new RegExp(description.pattern).test(value)).toBe(false);
    const script = platformFile('scripts/upload-local-images.mjs').content;
    expect(script).toContain("call('/artifacts/local-images', { method: 'POST', body: raw })");
    expect(script).toContain('print(data)');
    expect(script).not.toContain("type: 'snapshot'");
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);
    for (const text of [chat.systemPrompt, platformFile('SKILL.md').content]) {
      expect(text).toContain('upload_local_images');
      expect(text).toContain('Use each returned markdown verbatim');
      expect(text).toContain('10 MB each and 40 MB total');
      expect(text).toContain('never invent URLs');
      expect(text).toContain('WeChat output: WorkLite uses Tencent iLink private chat');
      expect(text).toContain('3500 UTF-8 bytes');
      expect(text).toContain('not an officially confirmed server limit');
      expect(text).toContain('Apply these restrictions to WeChat only');
    }
  });

  it('publishes the protected file tool and teaches Chat the actual WeChat trigger and limits', async () => {
    db = createDb(':memory:'); await initializeDatabase(db);
    const tools = JSON.parse(platformFile('scripts/tools.json').content);
    expect(tools['scripts/upload-local-files.mjs']).toMatchObject({ name: 'upload_local_files', inputSchema: {
      required: ['files'], additionalProperties: false, properties: { files: { minItems: 1, maxItems: 8, items: { required: ['path'], additionalProperties: false } } },
    } });
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);
    for (const text of [chat.systemPrompt, platformFile('SKILL.md').content]) {
      expect(text).toContain('upload_local_files');
      expect(text).toContain('20 MB each and 40 MB total');
      expect(text).toContain('/content?download=true');
      expect(text).toContain('Voice and native video sending remain unimplemented');
    }
  });

  it('does not expose a compatibility reader for deleted pre-group conversations', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const files = platformSkillPackageFiles();
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);
    expect(files.some((file) => file.path === 'scripts/inspect-coder-conversation-archive.mjs')).toBe(false);
    expect(chat.systemPrompt).not.toContain('inspect_coder_conversation_archive');
    expect(platformFile('SKILL.md').content).not.toContain('pre-group Coder conversation');
  });

  it('applies the empty-database path and removes all pre-group conversation tables', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const tables = db.$client.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const names = new Set(tables.map(({ name }) => name));
    expect(names.has('coder_conversation_archives')).toBe(false);
    expect(names.has('coder_conversations')).toBe(false);
    expect(names.has('coder_intakes')).toBe(false);
    expect(names.has('coder_conversation_messages')).toBe(false);
    expect(names.has('coder_conversation_events')).toBe(false);

    const runColumns = new Set((db.$client.pragma('table_info(coder_runs)') as Array<{ name: string }>).map(({ name }) => name));
    const groupColumns = new Set((db.$client.pragma('table_info(coder_groups)') as Array<{ name: string }>).map(({ name }) => name));
    expect(runColumns.has('mode')).toBe(false);
    expect(runColumns.has('mode_rationale')).toBe(false);
    expect(runColumns.has('mode_decided_at')).toBe(false);
    expect(groupColumns.has('mode')).toBe(false);
  });

  it('deletes legacy conversation data when dropping its unused tables', () => {
    db = createDb(':memory:');
    db.$client.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY);
      CREATE TABLE coders (id TEXT PRIMARY KEY);
      CREATE TABLE coder_conversations (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, coder_id TEXT NOT NULL,
        latest_project_directory TEXT, created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE coder_intakes (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        submission_id TEXT NOT NULL, goal TEXT, project_directory TEXT, mode TEXT,
        unresolved_field TEXT, status TEXT NOT NULL, run_id TEXT, created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE coder_conversation_messages (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL, intake_id TEXT, run_id TEXT, speaker TEXT NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL, deduplication_key TEXT, created_at INTEGER
      );
      CREATE TABLE coder_conversation_events (
        conversation_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL,
        payload TEXT NOT NULL, created_at INTEGER
      );
      INSERT INTO workspaces VALUES ('workspace_archive');
      INSERT INTO coders VALUES ('coder_archive');
      INSERT INTO coder_conversations VALUES ('conversation_archive', 'workspace_archive', 'coder_archive', '/repo', 1000, 2000);
      INSERT INTO coder_intakes VALUES ('intake_archive', 'workspace_archive', 'conversation_archive', 'submission_archive', 'Review the project', '/repo', NULL, NULL, 'started', 'run_archive', 1100, 1200);
      INSERT INTO coder_conversation_messages VALUES
        ('message_user', 'workspace_archive', 'conversation_archive', 1, 'intake_archive', NULL, 'user', 'task_request', '{"text":"Review the project"}', 'dedupe_user', 1300),
        ('message_role', 'workspace_archive', 'conversation_archive', 2, 'intake_archive', 'run_archive', 'member', 'run_answer', '{"text":"Review complete"}', 'dedupe_role', 1400);
      INSERT INTO coder_conversation_events VALUES
        ('conversation_archive', 1, 'message', '{"messageId":"message_user"}', 1300);
    `);

    const migration = readFileSync(resolve(process.cwd(), 'packages/db/drizzle/0071_drop_legacy_coder_conversations.sql'), 'utf8');
    db.$client.exec(migration);

    expect(db.$client.pragma('foreign_key_check')).toEqual([]);

    const remaining = db.$client.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const remainingNames = new Set(remaining.map(({ name }) => name));
    expect(remainingNames.has('coder_conversation_archives')).toBe(false);
    expect(remainingNames.has('coder_conversations')).toBe(false);
    expect(remainingNames.has('coder_intakes')).toBe(false);
    expect(remainingNames.has('coder_conversation_messages')).toBe(false);
    expect(remainingNames.has('coder_conversation_events')).toBe(false);
  });

  it('drops execution-mode columns from existing Run and group tables', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    db.$client.exec(`
      ALTER TABLE coder_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'implement_and_validate';
      ALTER TABLE coder_runs ADD COLUMN mode_rationale TEXT;
      ALTER TABLE coder_runs ADD COLUMN mode_decided_at INTEGER;
      ALTER TABLE coder_groups ADD COLUMN mode TEXT NOT NULL DEFAULT 'implement_and_validate';
    `);
    const migration = readFileSync(resolve(process.cwd(), 'packages/db/drizzle/0076_remove_coder_execution_modes.sql'), 'utf8');
    db.$client.exec(migration);

    const runColumns = new Set((db.$client.pragma('table_info(coder_runs)') as Array<{ name: string }>).map(({ name }) => name));
    const groupColumns = new Set((db.$client.pragma('table_info(coder_groups)') as Array<{ name: string }>).map(({ name }) => name));
    expect(runColumns.has('mode')).toBe(false);
    expect(runColumns.has('mode_rationale')).toBe(false);
    expect(runColumns.has('mode_decided_at')).toBe(false);
    expect(groupColumns.has('mode')).toBe(false);
  });

  it('exposes no Workflow or Coding Team control tools', () => {
    const tools = JSON.parse(platformFile('scripts/tools.json').content);
    expect(Object.keys(tools).some((path) => /coder|workflow/.test(path))).toBe(false);
  });

  it('closes a non-recoverable running tool call and persists its failure result', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const executionId = 'aex_restart_test';
    db.insert(schema.agentExecutions).values({
      id: executionId,
      workspaceId: 'workspace_personal',
      agentId: 'agt_system_helper_chat',
      modelMessages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_restart_test', toolName: 'inspect_workspace', input: {} }] },
      ],
      displayMessages: [],
      plan: [],
    }).run();
    db.insert(schema.agentToolCalls).values({
      id: 'acall_restart_test',
      executionId,
      workspaceId: 'workspace_personal',
      agentId: 'agt_system_helper_chat',
      toolCallId: 'call_restart_test',
      toolName: 'builtin',
      mcpToolName: 'inspect_workspace',
      workingDirectory: '/',
      arguments: [],
      packageFiles: [],
      output: '',
      resultAppended: false,
    }).run();

    await initializeDatabase(db);

    const [recoveredExecution] = db.select().from(schema.agentExecutions).where(eq(schema.agentExecutions.id, executionId)).limit(1).all();
    const [recoveredCall] = db.select().from(schema.agentToolCalls).where(eq(schema.agentToolCalls.id, 'acall_restart_test')).limit(1).all();

    expect(recoveredExecution.status).toBe('failed');
    expect(recoveredExecution.errorCode).toBe('restarted');
    expect(recoveredCall.status).toBe('failed');
    expect(recoveredCall.resultAppended).toBe(true);
    expect(recoveredCall.output).toBe('The API restarted before this Agent tool execution completed.');
    expect(recoveredExecution.modelMessages).toEqual([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_restart_test', toolName: 'inspect_workspace', input: {} }] },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call_restart_test',
          toolName: 'inspect_workspace',
          output: { type: 'error-text', value: 'The API restarted before this Agent tool execution completed. Outcome unknown; inspect effects before retrying.' },
        }],
      },
    ]);
  });

  it('interrupts a Claude project task left waiting_for_input, since its SDK session cannot survive a restart', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const executionId = 'aex_claude_wait_restart';
    const taskId = 'acall_claude_wait_restart';
    db.insert(schema.agentExecutions).values({
      id: executionId, workspaceId: 'workspace_personal', agentId: 'agt_system_helper_chat',
      modelMessages: [], displayMessages: [], plan: [],
    }).run();
    db.insert(schema.agentToolCalls).values({
      id: taskId, executionId, workspaceId: 'workspace_personal', agentId: 'agt_system_helper_chat',
      toolCallId: 'call_claude_wait_restart', toolName: 'builtin', mcpToolName: 'project_task',
      workingDirectory: '/', arguments: [], packageFiles: [], output: '', resultAppended: false,
    }).run();
    db.insert(schema.chatProjectTasks).values({
      id: taskId, workspaceId: 'workspace_personal', executionId,
      goal: 'investigate', projectDirectory: '/tmp', model: '',
      snapshot: {
        launch: { executor: 'claude', commandArguments: [], baseUrl: 'http://127.0.0.1:23392', model: null },
        projectInstructions: [], capabilities: { revision: 1 } as never,
      },
      status: 'waiting_for_input',
      pendingQuestion: { id: 'question_1', projectTaskId: taskId, question: '继续哪个方向？', options: [], createdAt: new Date().toISOString() },
      reportedAt: null,
    }).run();
    // A Codex task waiting_for_input is unaffected: its question already ended its process through
    // the deny-and-rerun path, so the task is durable state, not an in-process session.
    const codexTaskId = 'acall_codex_wait_restart';
    db.insert(schema.agentToolCalls).values({
      id: codexTaskId, executionId, workspaceId: 'workspace_personal', agentId: 'agt_system_helper_chat',
      toolCallId: 'call_codex_wait_restart', toolName: 'builtin', mcpToolName: 'project_task',
      workingDirectory: '/', arguments: [], packageFiles: [], output: '', resultAppended: false,
    }).run();
    db.insert(schema.chatProjectTasks).values({
      id: codexTaskId, workspaceId: 'workspace_personal', executionId,
      goal: 'investigate', projectDirectory: '/tmp', model: '',
      snapshot: {
        launch: { executor: 'codex', commandArguments: ['codex'], model: null },
        projectInstructions: [], capabilities: { revision: 1 } as never,
      },
      status: 'waiting_for_input',
      pendingQuestion: { id: 'question_2', projectTaskId: codexTaskId, question: '继续哪个方向？', options: [], createdAt: new Date().toISOString() },
      reportedAt: null,
    }).run();

    await initializeDatabase(db);

    const [claudeTask] = db.select().from(schema.chatProjectTasks).where(eq(schema.chatProjectTasks.id, taskId)).limit(1).all();
    expect(claudeTask.status).toBe('failed');
    expect(claudeTask.error).toContain('中断');
    expect(claudeTask.pendingQuestion).toEqual({ id: 'question_1', projectTaskId: taskId, question: '继续哪个方向？', options: [], createdAt: expect.any(String) });
    expect(claudeTask.reportedAt).not.toBeNull();

    const [codexTask] = db.select().from(schema.chatProjectTasks).where(eq(schema.chatProjectTasks.id, codexTaskId)).limit(1).all();
    expect(codexTask.status).toBe('waiting_for_input');
  });

  it('registers Agent configuration tools and public model fallback configuration', () => {
    const tools = JSON.parse(platformFile('scripts/tools.json').content);
    expect(tools['scripts/create-agent.mjs'].name).toBe('create_agent');
    expect(tools['scripts/update-agent.mjs'].name).toBe('update_agent');
    expect(tools['scripts/create-agent.mjs'].inputSchema.required).not.toContain('collaboration');
    expect(tools['scripts/delete-agent.mjs'].name).toBe('delete_agent');
    for (const path of ['scripts/create-agent.mjs', 'scripts/update-agent.mjs']) {
      expect(tools[path].inputSchema.properties).toHaveProperty('providerId');
      expect(tools[path].inputSchema.properties).toHaveProperty('model');
      expect(platformFile(path).content).toContain("'providerId', 'model'");
    }
    expect(platformFile('scripts/update-agent.mjs').content).toContain("method: 'PATCH'");
  });

  it('synchronizes ownership routes and cascade deletion rules into Chat and its tools', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    const chat = db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).get()!;
    expect(chat.systemPrompt).toContain('only top-level user-managed Agents');
    expect(chat.systemPrompt).toContain('GET/PATCH/DELETE /agents/:parentId/sub-agents/:childId');
    expect(chat.systemPrompt).toContain('Deleting an Agent cascades through all its descendants');
    const tools = JSON.parse(platformFile('scripts/tools.json').content);
    expect(tools['scripts/delete-agent.mjs'].description).toContain('all owned descendants are deleted in the same operation');
    expect(tools['scripts/delete-agent.mjs'].description).not.toContain('owned children removed first');
  });

  it('does not package graph editing, publishing or Workflow execution tools', () => {
    const files = platformSkillPackageFiles();
    expect(files.some((file) => file.path.includes('workflow'))).toBe(false);
    const tools = JSON.parse(platformFile('scripts/tools.json').content);
    expect(Object.keys(tools).some((path) => path.includes('workflow'))).toBe(false);
    expect(files.some((file) => file.path === 'scripts/dispatch-task.mjs')).toBe(false);
  });

  it('registers Agent deletion through the native Agent API', () => {
    expect(platformFile('scripts/delete-agent.mjs').content).toContain("method: 'DELETE'");
    expect(platformFile('scripts/delete-agent.mjs').content).toContain("'/agents/'");
  });

  it('registers categorized Chat memory platform tools', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const manifest = platformFile('scripts/tools.json');
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);

    const categories = ['rule', 'preference', 'project', 'project_state', 'workflow', 'other'];
    const tools = JSON.parse(manifest.content) as Record<string, { name: string; inputSchema: { required?: string[]; properties: Record<string, { enum?: string[] }> } }>;
    expect(tools['scripts/list-memories.mjs'].inputSchema.properties.category.enum).toEqual(categories);
    expect(tools['scripts/list-memories.mjs'].inputSchema.required ?? []).not.toContain('category');
    expect(tools['scripts/save-memory.mjs'].inputSchema.properties.category.enum).toEqual(categories);
    expect(tools['scripts/save-memory.mjs'].inputSchema.required).toEqual(['content']);
    expect(tools['scripts/update-memory.mjs'].inputSchema.properties.category.enum).toEqual(categories);
    expect(tools['scripts/update-memory.mjs'].inputSchema.required).toEqual(['memoryId']);
    expect(chat.systemPrompt).toContain('project-category memories');
  });
  it('registers the read-only local project lookup tool', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const script = platformFile('scripts/search-local-projects.mjs');
    const manifest = platformFile('scripts/tools.json');
    const skill = platformFile('SKILL.md');
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);

    expect(script.content).toContain('/local-projects/search');
    expect(script.content).toContain("raw.refresh === true");
    const tools = JSON.parse(manifest.content) as Record<string, { name: string; inputSchema: { required: string[]; properties: Record<string, { type?: string; maximum?: number }> } }>;
    expect(tools['scripts/search-local-projects.mjs'].name).toBe('search_local_projects');
    expect(tools['scripts/search-local-projects.mjs'].inputSchema.required).toEqual(['query']);
    expect(tools['scripts/search-local-projects.mjs'].inputSchema.properties.limit.maximum).toBe(50);
    expect(tools['scripts/search-local-projects.mjs'].inputSchema.properties.refresh.type).toBe('boolean');
    expect(skill.content).toContain('search_local_projects resolves a fuzzy project name');
    expect(skill.content).toContain('metadata-only local project index');
    expect(chat.systemPrompt).toContain('search_local_projects');
  });

  it('registers project alias tools that write only the alias dictionary', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const files = platformSkillPackageFiles();
    const content = new Map(files.map((file) => [file.path, file.content]));
    const tools = JSON.parse(content.get('scripts/tools.json')!) as Record<string, { name: string; inputSchema: { required?: string[] } }>;
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);

    expect(content.get('scripts/set-local-project-alias.mjs')).toContain("method: 'PUT'");
    expect(content.get('scripts/set-local-project-alias.mjs')).toContain('/local-projects/aliases');
    expect(content.get('scripts/remove-local-project-alias.mjs')).toContain("method: 'DELETE'");
    expect(content.get('scripts/list-local-project-aliases.mjs')).toContain('/local-projects/aliases');
    expect(tools['scripts/set-local-project-alias.mjs'].name).toBe('set_local_project_alias');
    expect(tools['scripts/set-local-project-alias.mjs'].inputSchema.required).toEqual(['alias', 'absolutePath']);
    expect(tools['scripts/remove-local-project-alias.mjs'].name).toBe('remove_local_project_alias');
    expect(tools['scripts/remove-local-project-alias.mjs'].inputSchema.required).toEqual(['alias']);
    expect(tools['scripts/list-local-project-aliases.mjs'].name).toBe('list_local_project_aliases');
    expect(tools['scripts/list-local-project-aliases.mjs'].inputSchema.required ?? []).toEqual([]);
    // The model must not invent mappings: only user-stated ones are recorded.
    expect(content.get('scripts/tools.json')).toContain('never guess a mapping');
    expect(content.get('SKILL.md')).toContain('set_local_project_alias');
    expect(content.get('SKILL.md')).toContain('explicitly supplied by the user');
    expect(chat.systemPrompt).toContain('set_local_project_alias');
    expect(chat.systemPrompt).toContain('never guessed or bulk-generated');
  });

  it('documents the unified Agents page as the task configuration destination', () => {
    const skill = platformFile('SKILL.md').content;
    expect(skill).toContain('/agents');
    expect(skill).not.toContain('/coding');
    expect(skill).not.toContain('/workflows');
    expect(skill).toContain('do not call search_local_projects to look for a same-named repository');
  });

  it('removes dispatch_task and keeps native Agent management tools', () => {
    const content = new Map(platformSkillPackageFiles().map((file) => [file.path, file.content]));
    const tools = JSON.parse(content.get('scripts/tools.json')!);
    expect(content.has('scripts/dispatch-task.mjs')).toBe(false);
    expect(tools['scripts/dispatch-task.mjs']).toBeUndefined();
    expect(tools['scripts/create-agent.mjs'].name).toBe('create_agent');
  });

  it('routes code and automation tasks through dynamically coordinated Agents', async () => {
    db = createDb(':memory:'); await initializeDatabase(db);
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);
    expect(chat.systemPrompt).toContain('run_agent');
    expect(chat.systemPrompt).toContain('projectDirectory');
    expect(chat.systemPrompt).toContain('promptly delegate the original user request');
    expect(platformFile('SKILL.md').content).toContain('promptly delegate the original user request');
    expect(chat.systemPrompt).not.toMatch(/\bdispatch_task\b|\binspect_coders\b/);
  });

  it('routes automation through dynamically coordinated Agents', async () => {
    db = createDb(':memory:'); await initializeDatabase(db);
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);
    expect(chat.systemPrompt).toContain('inspect_agents');
    expect(chat.systemPrompt).toContain('run_agent');
    expect(chat.systemPrompt).not.toMatch(/\b(?:inspect|patch|edit|create|publish)_workflow\b/);
    expect(platformFile('SKILL.md').content).toContain('run_agent');
    expect(platformFile('scripts/query-platform.mjs').content).toContain("READ_PREFIXES = ['/agents'");
  });

  it('registers query_platform as a bounded, redacting GET-only read tool', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const files = platformSkillPackageFiles();
    const content = new Map(files.map((file) => [file.path, file.content]));
    const tools = JSON.parse(content.get('scripts/tools.json')!) as Record<string, { name: string; inputSchema: { required?: string[]; properties: Record<string, { enum?: string[] }> } }>;
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);

    expect(content.get('scripts/query-platform.mjs')).toContain("raw.method !== 'GET'");
    expect(content.get('scripts/query-platform.mjs')).toContain("decoded === '..'");
    expect(content.get('scripts/query-platform.mjs')).toContain("redirect: 'error'");
    expect(content.get('scripts/query-platform.mjs')).toContain('SENSITIVE_KEYS');
    expect(tools['scripts/query-platform.mjs'].name).toBe('query_platform');
    expect(tools['scripts/query-platform.mjs'].inputSchema.required).toEqual(['path']);
    expect(tools['scripts/query-platform.mjs'].inputSchema.properties.method.enum).toEqual(['GET']);
    expect(content.get('SKILL.md')).toContain('query_platform');
    expect(chat.systemPrompt).toContain('query_platform');
  });

  it('publishes the general Chat terminal tool and its split from project tasks', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const files = platformSkillPackageFiles();
    const content = new Map(files.map((file) => [file.path, file.content]));
    const tools = JSON.parse(content.get('scripts/tools.json')!) as Record<string, {
      name: string;
      description: string;
      inputSchema: { required?: string[]; additionalProperties?: boolean; properties: Record<string, { type?: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number }> };
    }>;
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);
    const skill = content.get('SKILL.md')!;
    const terminal = tools['__runtime__/run-host-command'];

    expect(terminal.name).toBe('run_host_command');
    expect(terminal.inputSchema.required).toEqual(['command']);
    expect(terminal.inputSchema.additionalProperties).toBe(false);
    expect(terminal.inputSchema.properties.command).toMatchObject({ type: 'string', minLength: 1, maxLength: 20_000 });
    expect(terminal.inputSchema.properties.cwd).toMatchObject({ type: 'string', maxLength: 4_096 });
    expect(terminal.inputSchema.properties.timeoutMs).toMatchObject({ type: 'integer', minimum: 100, maximum: 900_000 });
    expect(terminal.description).toContain('no command allow-list');
    expect(terminal.description).toContain('run_agent to an Agent');
    expect(tools['scripts/run-host-command.mjs']).toBeUndefined();
    expect(skill).toContain('Use run_host_command directly');
    expect(skill).toContain('no command allow-list');
    expect(skill).toContain('Codex');
    expect(skill).toContain('ordinary file management');
    expect(skill).not.toContain('batch file changes and directory removal belong to a project executor');
    expect(skill).not.toMatch(/whitelist|restricted Chat|no new Shell execution|no direct read|no bash/i);
    expect(chat.systemPrompt).toContain('run_host_command');
    expect(chat.systemPrompt).toContain('Do not dispatch an Agent for those operations');
    expect(chat.systemPrompt).toContain('build/test validation belong to an appropriate Agent');
    expect(chat.systemPrompt).not.toMatch(/whitelist|restricted run_host_command|General read, glob, grep and bash|no bash|no direct read/i);
  });

  it('registers saved Provider model tools with credential-free outputs', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const files = platformSkillPackageFiles();
    const content = new Map(files.map((file) => [file.path, file.content]));
    const tools = JSON.parse(content.get('scripts/tools.json')!) as Record<string, {
      name: string;
      description: string;
      inputSchema: { required?: string[]; properties: Record<string, { type?: string; minItems?: number; maxItems?: number; items?: { minLength?: number; maxLength?: number } }> };
    }>;
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);
    const discover = tools['scripts/discover-provider-models.mjs'];
    const update = tools['scripts/update-provider-models.mjs'];

    expect(discover.name).toBe('discover_provider_models');
    expect(discover.inputSchema.required).toEqual(['providerId']);
    expect(discover.description).toContain('stored credentials');
    expect(update.name).toBe('update_provider_models');
    expect(update.inputSchema.required).toEqual(['providerId', 'addModels']);
    expect(update.inputSchema.properties.addModels).toMatchObject({ type: 'array', minItems: 1, maxItems: 100 });
    expect(update.inputSchema.properties.addModels.items).toMatchObject({ minLength: 1, maxLength: 240 });
    expect(content.get('scripts/discover-provider-models.mjs')).toContain('/discover-models');
    expect(content.get('scripts/discover-provider-models.mjs')).not.toMatch(/apiKey|api_key|encrypted/i);
    expect(content.get('scripts/update-provider-models.mjs')).toContain("method: 'PATCH'");
    expect(content.get('scripts/update-provider-models.mjs')).not.toMatch(/apiKey|api_key|encrypted/i);
    expect(content.get('SKILL.md')).toContain('discover_provider_models');
    expect(content.get('SKILL.md')).toContain('update_provider_models');
    expect(chat.systemPrompt).toContain('discover_provider_models(providerId)');
    expect(chat.systemPrompt).toContain('update_provider_models(providerId, addModels)');
    expect(chat.systemPrompt).toContain('never request or return API keys');
  });
});
