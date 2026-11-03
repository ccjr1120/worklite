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

  it('retires active pre-Router Runs instead of resuming their old graph', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    const now = new Date();
    await db.insert(schema.coders).values({
      id: 'coder_pre_router', workspaceId: 'workspace_personal', name: 'Pre Router', description: 'migration fixture',
      processId: 'bmad-tea', processVersion: '1', roles: [], createdAt: now, updatedAt: now,
    });
    await db.insert(schema.coderVersions).values({
      id: 'version_pre_router', workspaceId: 'workspace_personal', coderId: 'coder_pre_router', version: 1,
      snapshot: { processId: 'bmad-tea', processVersion: '1', manifestHash: '', developerExecution: { kind: 'codex_app_server' }, orchestrationVersion: 11, roles: [] } as never,
      createdAt: now,
    });
    await db.insert(schema.coderRuns).values({
      id: 'run_pre_router', workspaceId: 'workspace_personal', coderId: 'coder_pre_router', coderVersionId: 'version_pre_router',
      intent: 'old task', projectDirectory: '/repo', langGraphThreadId: 'thread_pre_router', status: 'running',
      createdAt: now, updatedAt: now,
    });
    await db.insert(schema.coderRuns).values({
      id: 'run_pre_router_terminal', workspaceId: 'workspace_personal', coderId: 'coder_pre_router', coderVersionId: 'version_pre_router',
      intent: 'old completed task', projectDirectory: '/repo', langGraphThreadId: 'thread_pre_router_terminal', status: 'succeeded',
      createdAt: now, updatedAt: now, finishedAt: now,
    });
    await db.insert(schema.coderTaskAttempts).values({
      id: 'attempt_pre_router', workspaceId: 'workspace_personal', runId: 'run_pre_router', taskKey: 'developer', attemptIndex: 0,
      role: 'developer', status: 'running', inputRevision: {}, inputFingerprint: 'pre-router', createdAt: now, startedAt: now,
    });
    await db.insert(schema.coderPendingInputs).values({
      id: 'pending_pre_router', workspaceId: 'workspace_personal', runId: 'run_pre_router', taskAttemptId: 'attempt_pre_router',
      kind: 'question', question: 'old question', scopeRevision: 1, status: 'pending', createdAt: now, updatedAt: now,
    });

    const migration = readFileSync(resolve(process.cwd(), 'packages/db/drizzle/0072_retire_legacy_coder_runs.sql'), 'utf8');
    db.$client.exec(migration);

    const [run] = await db.select().from(schema.coderRuns).where(eq(schema.coderRuns.id, 'run_pre_router')).limit(1);
    const [terminalRun] = await db.select().from(schema.coderRuns).where(eq(schema.coderRuns.id, 'run_pre_router_terminal')).limit(1);
    const [attempt] = await db.select().from(schema.coderTaskAttempts).where(eq(schema.coderTaskAttempts.id, 'attempt_pre_router')).limit(1);
    const [pending] = await db.select().from(schema.coderPendingInputs).where(eq(schema.coderPendingInputs.id, 'pending_pre_router')).limit(1);
    const events = await db.select().from(schema.coderRunEvents).where(eq(schema.coderRunEvents.runId, 'run_pre_router'));
    expect(run).toMatchObject({ status: 'failed', desiredControlState: 'none' });
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(attempt).toMatchObject({ status: 'failed', active: false, error: 'This Run uses a retired orchestration version. Start a new Router Run.' });
    expect(pending.status).toBe('cancelled');
    expect(events).toContainEqual(expect.objectContaining({ type: 'run.status', payload: expect.objectContaining({ status: 'failed' }) }));
    expect(terminalRun).toMatchObject({ status: 'succeeded', finishedAt: now });
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
  });

  it('retires paused Runs and pause requests with their active attempts and pending inputs', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    const now = new Date();
    await db.insert(schema.coders).values({
      id: 'coder_pause_migration', workspaceId: 'workspace_personal', name: 'Pause migration', description: 'migration fixture',
      processId: 'bmad-tea', processVersion: '1', roles: [], createdAt: now, updatedAt: now,
    });
    await db.insert(schema.coderVersions).values({
      id: 'version_pause_migration', workspaceId: 'workspace_personal', coderId: 'coder_pause_migration', version: 1,
      snapshot: { processId: 'bmad-tea', processVersion: '1', manifestHash: '', orchestrationVersion: 12, roles: [] } as never,
      createdAt: now,
    });
    await db.insert(schema.coderRuns).values([
      {
        id: 'run_paused_legacy', workspaceId: 'workspace_personal', coderId: 'coder_pause_migration', coderVersionId: 'version_pause_migration',
        intent: 'paused task', projectDirectory: '/repo', langGraphThreadId: 'thread_paused_legacy', status: 'paused' as never,
        createdAt: now, updatedAt: now,
      },
      {
        id: 'run_pause_requested', workspaceId: 'workspace_personal', coderId: 'coder_pause_migration', coderVersionId: 'version_pause_migration',
        intent: 'pause requested task', projectDirectory: '/repo', langGraphThreadId: 'thread_pause_requested', status: 'running',
        desiredControlState: 'pause_requested' as never, createdAt: now, updatedAt: now,
      },
    ]);
    await db.insert(schema.coderTaskAttempts).values([
      { id: 'attempt_paused_legacy', workspaceId: 'workspace_personal', runId: 'run_paused_legacy', taskKey: 'developer', attemptIndex: 0, role: 'developer', status: 'running', active: true, inputRevision: {}, inputFingerprint: 'paused', createdAt: now, startedAt: now },
      { id: 'attempt_pause_requested', workspaceId: 'workspace_personal', runId: 'run_pause_requested', taskKey: 'developer', attemptIndex: 0, role: 'developer', status: 'running', active: true, inputRevision: {}, inputFingerprint: 'pause-requested', createdAt: now, startedAt: now },
    ]);
    await db.insert(schema.coderPendingInputs).values([
      { id: 'pending_paused_legacy', workspaceId: 'workspace_personal', runId: 'run_paused_legacy', taskAttemptId: 'attempt_paused_legacy', kind: 'question', question: 'old pause question', scopeRevision: 1, status: 'pending', createdAt: now, updatedAt: now },
      { id: 'pending_pause_requested', workspaceId: 'workspace_personal', runId: 'run_pause_requested', taskAttemptId: 'attempt_pause_requested', kind: 'question', question: 'pause request question', scopeRevision: 1, status: 'pending', createdAt: now, updatedAt: now },
    ]);

    const migration = readFileSync(resolve(process.cwd(), 'packages/db/drizzle/0073_remove_coder_run_pause.sql'), 'utf8');
    db.$client.exec(migration);

    for (const [runId, attemptId, pendingId] of [
      ['run_paused_legacy', 'attempt_paused_legacy', 'pending_paused_legacy'],
      ['run_pause_requested', 'attempt_pause_requested', 'pending_pause_requested'],
    ]) {
      const [run] = await db.select().from(schema.coderRuns).where(eq(schema.coderRuns.id, runId!)).limit(1);
      const [attempt] = await db.select().from(schema.coderTaskAttempts).where(eq(schema.coderTaskAttempts.id, attemptId!)).limit(1);
      const [pending] = await db.select().from(schema.coderPendingInputs).where(eq(schema.coderPendingInputs.id, pendingId!)).limit(1);
      expect(run).toMatchObject({ status: 'failed', desiredControlState: 'none' });
      expect(run!.finishedAt).toBeInstanceOf(Date);
      expect(attempt).toMatchObject({ status: 'failed', active: false });
      expect(pending!.status).toBe('cancelled');
    }
    const events = await db.select().from(schema.coderRunEvents);
    expect(events.filter(({ type }) => type === 'run.status')).toHaveLength(2);
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
  });

  it('removes old developer-lane fields from current Coder settings but preserves version snapshots', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    const now = new Date();
    await db.insert(schema.coders).values({
      id: 'coder_old_lanes', workspaceId: 'workspace_personal', name: 'Old lanes', description: 'migration fixture',
      processId: 'bmad-tea', processVersion: '1', roles: [
        { role: 'planner', developerConcurrency: 4 },
        { role: 'developer', developerInstances: [{ developerId: 'developer-2', label: 'Developer 2' }] },
        { role: 'dispatcher', instructions: 'Old dispatcher role' },
        { role: 'executor-manager', instructions: 'Old executor manager role' },
        { role: 'worktree-manager', instructions: 'Old worktree role' },
      ] as never, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.coderVersions).values({
      id: 'version_old_lanes', workspaceId: 'workspace_personal', coderId: 'coder_old_lanes', version: 1,
      snapshot: {
        processId: 'bmad-tea', processVersion: '1', orchestrationVersion: 11,
        developerExecution: { kind: 'codex_app_server' },
        roles: [{ role: 'developer', developerInstances: [{ developerId: 'developer-2' }] }],
      } as never,
      createdAt: now,
    });

    const migration = readFileSync(resolve(process.cwd(), 'packages/db/drizzle/0074_remove_legacy_coder_lanes.sql'), 'utf8');
    db.$client.exec(migration);

    const [coder] = await db.select().from(schema.coders).where(eq(schema.coders.id, 'coder_old_lanes')).limit(1);
    const [version] = await db.select().from(schema.coderVersions).where(eq(schema.coderVersions.id, 'version_old_lanes')).limit(1);
    expect(coder.roles).toEqual([{ role: 'planner' }, { role: 'developer' }]);
    expect((version.snapshot.roles[0] as Record<string, unknown>).developerInstances).toEqual([{ developerId: 'developer-2' }]);
  });

  it('rewrites Router handoffs as assignments and results while keeping historical direct handoffs', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    const now = new Date();
    await db.insert(schema.coders).values({
      id: 'coder_message_kinds', workspaceId: 'workspace_personal', name: 'Message kinds', description: 'migration fixture',
      processId: 'bmad-tea', processVersion: '1', roles: [], createdAt: now, updatedAt: now,
    });
    await db.insert(schema.coderVersions).values([
      { id: 'version_message_kinds_v12', workspaceId: 'workspace_personal', coderId: 'coder_message_kinds', version: 12, snapshot: { orchestrationVersion: 12, roles: [] } as never, createdAt: now },
      { id: 'version_message_kinds_v11', workspaceId: 'workspace_personal', coderId: 'coder_message_kinds', version: 11, snapshot: { orchestrationVersion: 11, roles: [] } as never, createdAt: now },
    ]);
    await db.insert(schema.coderGroups).values({ id: 'group_message_kinds', workspaceId: 'workspace_personal', coderId: 'coder_message_kinds', createdAt: now, updatedAt: now });
    await db.insert(schema.coderRuns).values([
      { id: 'run_message_kinds_v12', workspaceId: 'workspace_personal', coderId: 'coder_message_kinds', coderVersionId: 'version_message_kinds_v12', groupId: 'group_message_kinds', intent: 'current', projectDirectory: '/repo', langGraphThreadId: 'thread_message_kinds_v12', createdAt: now, updatedAt: now },
      { id: 'run_message_kinds_v11', workspaceId: 'workspace_personal', coderId: 'coder_message_kinds', coderVersionId: 'version_message_kinds_v11', groupId: 'group_message_kinds', intent: 'historical', projectDirectory: '/repo', langGraphThreadId: 'thread_message_kinds_v11', createdAt: now, updatedAt: now },
    ]);
    await db.insert(schema.coderGroupMessages).values([
      { id: 'message_router_assignment', workspaceId: 'workspace_personal', groupId: 'group_message_kinds', sequence: 1, sender: 'role', senderRole: 'router', recipientRole: 'planner', kind: 'handoff' as never, body: 'Assigned', runId: 'run_message_kinds_v12', createdAt: now },
      { id: 'message_router_result', workspaceId: 'workspace_personal', groupId: 'group_message_kinds', sequence: 2, sender: 'role', senderRole: 'planner', recipientRole: 'router', kind: 'handoff' as never, body: 'Finished', runId: 'run_message_kinds_v12', createdAt: now },
      { id: 'message_v12_direct', workspaceId: 'workspace_personal', groupId: 'group_message_kinds', sequence: 3, sender: 'role', senderRole: 'developer', recipientRole: 'planner', kind: 'handoff' as never, body: 'Historical direct handoff', runId: 'run_message_kinds_v12', createdAt: now },
      { id: 'message_v11_direct', workspaceId: 'workspace_personal', groupId: 'group_message_kinds', sequence: 4, sender: 'role', senderRole: 'developer', recipientRole: 'planner', kind: 'handoff' as never, body: 'Old direct handoff', runId: 'run_message_kinds_v11', createdAt: now },
    ]);

    const migration = readFileSync(resolve(process.cwd(), 'packages/db/drizzle/0075_router_group_message_kinds.sql'), 'utf8');
    db.$client.exec(migration);

    const messages = await db.select().from(schema.coderGroupMessages).orderBy(schema.coderGroupMessages.sequence);
    expect(messages.map(({ id, kind }) => [id, kind])).toEqual([
      ['message_router_assignment', 'assignment'],
      ['message_router_result', 'result'],
      ['message_v12_direct', 'handoff'],
      ['message_v11_direct', 'handoff'],
    ]);
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
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

  it('exposes only Run cancellation; task continuation uses the Router group operation', () => {
    const tools = JSON.parse(platformFile('scripts/tools.json').content) as Record<string, { inputSchema: { properties: Record<string, unknown>; required: string[] } }>;
    const control = tools['scripts/control-coder-run.mjs'];
    expect(control.inputSchema.properties).toEqual({ runId: expect.any(Object), action: { type: 'string', enum: ['cancel'] } });
    const script = platformFile('scripts/control-coder-run.mjs').content;
    expect(script).not.toMatch(/resume|retry|pause/);
    expect(platformFile('scripts/control-coder-group.mjs').content).toContain('continue_task');
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
          output: { type: 'error-text', value: 'The API restarted before this Agent tool execution completed.' },
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

  it('registers the Workflow Agent model replacement platform tool', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const script = platformFile('scripts/replace-workflow-agent-models.mjs');
    const manifest = platformFile('scripts/tools.json');
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);

    expect(script.content).toContain('/draft/model-replacement');
    const tools = JSON.parse(manifest.content) as Record<string, { name: string; inputSchema: { required: string[] } }>;
    expect(tools['scripts/replace-workflow-agent-models.mjs'].name).toBe('replace_workflow_agent_models');
    expect(tools['scripts/replace-workflow-agent-models.mjs'].inputSchema.required).toEqual(['workflowId', 'fromModel', 'toModel']);
    expect(chat.systemPrompt).toContain('replace_workflow_agent_models');
  });

  it('registers the in-place Workflow patch platform tool', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const content = new Map(platformSkillPackageFiles().map((file) => [file.path, file.content]));
    const tools = JSON.parse(content.get('scripts/tools.json')!) as Record<string, { name: string; description: string; inputSchema: { required: string[]; properties: Record<string, { type?: string; items?: { anyOf?: unknown[] } }> } }>;
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);
    const patch = tools['scripts/patch-workflow.mjs'];

    expect(content.get('scripts/patch-workflow.mjs')).toContain('/draft/operations');
    expect(content.get('scripts/patch-workflow.mjs')).toContain("exactKeys(raw, ['workflowId', 'baseRevisionId', 'sourceInstruction', 'patch'])");
    expect(content.get('scripts/patch-workflow.mjs')).toContain('patch: raw.patch');
    expect(patch.name).toBe('patch_workflow');
    expect(patch.inputSchema.required).toEqual(['workflowId', 'sourceInstruction', 'patch']);
    expect(patch.inputSchema.properties.patch.type).toBe('array');
    expect(patch.inputSchema.properties.patch.items?.anyOf).toHaveLength(6);
    expect(patch.description).toContain('configPatch');
    expect(patch.description).toContain('requiredSkillIds');
    // edit_workflow keeps its whole-graph replacement semantics.
    expect(tools['scripts/edit-workflow.mjs'].inputSchema.required).toEqual(['workflowId', 'sourceInstruction', 'plan']);
    expect(chat.systemPrompt).toContain('patch_workflow');
    expect(chat.systemPrompt).toContain('requiredSkillIds');
  });

  it('registers the guarded Workflow deletion platform tool', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const script = platformFile('scripts/delete-workflow.mjs');
    const manifest = platformFile('scripts/tools.json');
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
    expect(content.get('SKILL.md')).toContain('dino-datahub');
    expect(chat.systemPrompt).toContain('set_local_project_alias');
    expect(chat.systemPrompt).toContain('never guessed or bulk-generated');
  });

  it('maps sidebar page labels to Web routes in one Skill section', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const skill = platformFile('SKILL.md');
    expect(skill.content.match(/## Pages and routes \(UI navigation\)/g)).toHaveLength(1);
    expect(skill.content).toContain('| 工作区 | Coding | `/coding` |');
    expect(skill.content).toContain('`/coding/:coderId/config`');
    expect(skill.content).toContain('`/coding/runs/:runId`');
    expect(skill.content).toContain('do not call search_local_projects to look for a same-named repository');
    // Route listings live only in the navigation section.
    expect(skill.content).not.toContain('Chat Channels at /chat?view=channels');
    expect(skill.content).not.toContain('`/coding/:coderId` lists an executor’s Runs');
  });

  it('registers dispatch_task without an Agent Team mode', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const script = platformFile('scripts/dispatch-task.mjs');
    const manifest = platformFile('scripts/tools.json');
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);

    const tools = JSON.parse(manifest.content) as Record<string, { name: string; inputSchema: unknown }>;
    const dispatch = Object.values(tools).find((tool) => tool.name === 'dispatch_task')!;
    expect(JSON.stringify(dispatch.inputSchema)).not.toContain('plan_only');
    expect(JSON.stringify(dispatch.inputSchema)).not.toMatch(/"mode"/);
    expect(script.content).not.toContain('mode');
    expect(script.content).toContain("'role'");
    const skill = platformFile('SKILL.md');
    expect(chat.systemPrompt).toContain('New Chat dispatches always enter the server-owned Router');
    expect(chat.systemPrompt).not.toContain('Executors do not accept a mode');
    expect(chat.systemPrompt).not.toContain('supported mode');
    expect(skill.content).not.toContain('supported mode');
  });

  it('routes Chat project work through Coding Team instead of project_task', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);
    const skill = platformFile('SKILL.md');
    expect(chat.systemPrompt).toContain('dispatch coding, cross-file changes, repository-wide investigation and validation/build/test work to Coders');
    expect(chat.systemPrompt).toContain('New Chat dispatches always enter the server-owned Router');
    expect(chat.systemPrompt).not.toMatch(/\b(?:answer|steer|cancel)_project_task\b|redeployAfterSuccess|Agent Team/);
    expect(skill.content).not.toMatch(/\b(?:answer|steer|cancel)_project_task\b|redeployAfterSuccess|Agent Team/);
    expect(skill.content).toContain('dispatch_task');
    expect(skill.content).toContain('Coder');
    expect(skill.content).toContain('Router');
  });

  it('registers the direct Workflow inspection platform tool', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const files = platformSkillPackageFiles();
    const content = new Map(files.map((file) => [file.path, file.content]));
    const tools = JSON.parse(content.get('scripts/tools.json')!) as Record<string, { name: string; inputSchema: { required?: string[]; properties: Record<string, { enum?: string[]; minimum?: number; maximum?: number }> } }>;
    const [chat] = await db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).limit(1);

    expect(content.get('scripts/inspect-workflow.mjs')).toContain('/versions');
    expect(content.get('scripts/inspect-workflow.mjs')).toContain('/schedule');
    expect(content.get('scripts/inspect-workflow.mjs')).toContain("versionsMode === 'none'");
    expect(content.get('scripts/inspect-workflow.mjs')).toContain('omittedVersionDefinitions');
    expect(tools['scripts/inspect-workflow.mjs'].name).toBe('inspect_workflow');
    expect(tools['scripts/inspect-workflow.mjs'].inputSchema.required ?? []).toEqual([]);
    expect(tools['scripts/inspect-workflow.mjs'].inputSchema.properties.versions.enum).toEqual(['latest', 'all', 'none']);
    expect(tools['scripts/inspect-workflow.mjs'].inputSchema.properties.runLimit.maximum).toBe(20);
    expect(content.get('SKILL.md')).toContain('inspect_workflow');
    expect(content.get('SKILL.md')).not.toContain('never a reason to delegate');
    expect(chat.systemPrompt).toContain('inspect_workflow');
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
    expect(terminal.description).toContain('dispatch_task to a Coder');
    expect(tools['scripts/run-host-command.mjs']).toBeUndefined();
    expect(skill).toContain('Use run_host_command directly');
    expect(skill).toContain('no command allow-list');
    expect(skill).toContain('executor');
    expect(skill).toContain('ordinary file management');
    expect(skill).not.toContain('batch file changes and directory removal belong to a project executor');
    expect(skill).not.toMatch(/whitelist|restricted Chat|no new Shell execution|no direct read|no bash/i);
    expect(chat.systemPrompt).toContain('run_host_command');
    expect(chat.systemPrompt).toContain('Do not dispatch a Coder for those operations');
    expect(chat.systemPrompt).toContain('dispatch coding, cross-file changes, repository-wide investigation and validation/build/test work to Coders');
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
