import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, initializeDatabase } from './client';
import * as schema from './schema';
import type { Database } from './client';

let db: Database | undefined;

afterEach(() => {
  db?.$client.close();
  db = undefined;
});

describe('initializeDatabase restart recovery', () => {
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
          output: { type: 'error-text', value: 'The API restarted before this Agent tool execution completed.' },
        }],
      },
    ]);
  });

  it('registers the Workflow Agent model replacement platform tool', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const [script] = await db.select().from(schema.skillFiles).where(and(eq(schema.skillFiles.skillId, 'sk_worklite_platform'), eq(schema.skillFiles.path, 'scripts/replace-workflow-agent-models.mjs'))).limit(1);
    const [manifest] = await db.select().from(schema.skillFiles).where(and(eq(schema.skillFiles.skillId, 'sk_worklite_platform'), eq(schema.skillFiles.path, 'scripts/tools.json'))).limit(1);
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);

    expect(script.content).toContain('/draft/model-replacement');
    const tools = JSON.parse(manifest.content) as Record<string, { name: string; inputSchema: { required: string[] } }>;
    expect(tools['scripts/replace-workflow-agent-models.mjs'].name).toBe('replace_workflow_agent_models');
    expect(tools['scripts/replace-workflow-agent-models.mjs'].inputSchema.required).toEqual(['workflowId', 'fromModel', 'toModel']);
    expect(chat.systemPrompt).toContain('replace_workflow_agent_models');
  });

  it('registers the guarded Workflow deletion platform tool', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const [script] = await db.select().from(schema.skillFiles).where(and(eq(schema.skillFiles.skillId, 'sk_worklite_platform'), eq(schema.skillFiles.path, 'scripts/delete-workflow.mjs'))).limit(1);
    const [manifest] = await db.select().from(schema.skillFiles).where(and(eq(schema.skillFiles.skillId, 'sk_worklite_platform'), eq(schema.skillFiles.path, 'scripts/tools.json'))).limit(1);
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);

    expect(script.content).toContain("raw.confirm !== true");
    expect(script.content).toContain("method: 'DELETE'");
    const tools = JSON.parse(manifest.content) as Record<string, { name: string; inputSchema: { required: string[]; properties: Record<string, { default?: boolean }> } }>;
    expect(tools['scripts/delete-workflow.mjs'].name).toBe('delete_workflow');
    expect(tools['scripts/delete-workflow.mjs'].inputSchema.required).toEqual(['workflowId', 'confirm']);
    expect(tools['scripts/delete-workflow.mjs'].inputSchema.properties.force.default).toBe(false);
    expect(chat.systemPrompt).toContain('delete_workflow');
  });

  it('registers categorized Chat memory platform tools', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const [manifest] = await db.select().from(schema.skillFiles).where(and(eq(schema.skillFiles.skillId, 'sk_worklite_platform'), eq(schema.skillFiles.path, 'scripts/tools.json'))).limit(1);
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

    const [script] = await db.select().from(schema.skillFiles).where(and(eq(schema.skillFiles.skillId, 'sk_worklite_platform'), eq(schema.skillFiles.path, 'scripts/search-local-projects.mjs'))).limit(1);
    const [manifest] = await db.select().from(schema.skillFiles).where(and(eq(schema.skillFiles.skillId, 'sk_worklite_platform'), eq(schema.skillFiles.path, 'scripts/tools.json'))).limit(1);
    const [skill] = await db.select().from(schema.skillFiles).where(and(eq(schema.skillFiles.skillId, 'sk_worklite_platform'), eq(schema.skillFiles.path, 'SKILL.md'))).limit(1);
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

    const files = await db.select().from(schema.skillFiles).where(eq(schema.skillFiles.skillId, 'sk_worklite_platform'));
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
    expect(content.get('SKILL.md')).toContain('dino-datahub');
    expect(chat.systemPrompt).toContain('set_local_project_alias');
    expect(chat.systemPrompt).toContain('never guessed or bulk-generated');
  });

  it('registers dispatch_task without an Agent Team mode', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const [script] = await db.select().from(schema.skillFiles).where(and(eq(schema.skillFiles.skillId, 'sk_worklite_platform'), eq(schema.skillFiles.path, 'scripts/dispatch-task.mjs'))).limit(1);
    const [manifest] = await db.select().from(schema.skillFiles).where(and(eq(schema.skillFiles.skillId, 'sk_worklite_platform'), eq(schema.skillFiles.path, 'scripts/tools.json'))).limit(1);
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);

    const tools = JSON.parse(manifest.content) as Record<string, { name: string; inputSchema: unknown }>;
    const dispatch = Object.values(tools).find((tool) => tool.name === 'dispatch_task')!;
    expect(JSON.stringify(dispatch.inputSchema)).not.toContain('plan_only');
    expect(JSON.stringify(dispatch.inputSchema)).not.toMatch(/"mode"/);
    // Older callers may still send a mode; the script accepts it but never forwards it.
    expect(script.content).toContain("'mode', 'role'");
    expect(script.content).not.toContain("oneOf(target.mode");
    const [skill] = await db.select().from(schema.skillFiles).where(and(eq(schema.skillFiles.skillId, 'sk_worklite_platform'), eq(schema.skillFiles.path, 'SKILL.md'))).limit(1);
    expect(chat.systemPrompt).toContain('Agent Teams do not accept a mode');
    expect(chat.systemPrompt).not.toContain('supported mode');
    expect(skill.content).toContain('Never ask the user to choose a mode');
    expect(skill.content).not.toContain('supported mode');
  });

  it('documents steering a running project task instead of forbidding it', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const [skill] = await db.select().from(schema.skillFiles).where(and(eq(schema.skillFiles.skillId, 'sk_worklite_platform'), eq(schema.skillFiles.path, 'SKILL.md'))).limit(1);
    expect(skill.content).toContain('call steer_project_task');
    expect(skill.content).not.toContain('never steer or append a correction');
  });
});
