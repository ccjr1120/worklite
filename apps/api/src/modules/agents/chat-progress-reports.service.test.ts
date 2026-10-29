import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { createDb, type Database } from '@worklite/db';
import { activeWorkSignature, buildActiveWorkNote, ChatProgressReportsService, DEFAULT_PROGRESS_NOTE_INTERVAL_SECONDS, type ActiveWorkItem } from './chat-progress-reports.service';
import type { AgentExecutionsService } from './agent-executions.service';
import type { AgentTeamRuntimeService } from '../executors/executor-runtime.service';

const WORKSPACE_ID = 'workspace_personal';
const EXECUTION_ID = 'aex_progress_test';
const TASK_ID = 'acall_progress_test';

// The progress reporter queries the task, submission and Run tables directly; the execution
// state guard lives in the stubbed AgentExecutionsService.reportActiveWorkProgress.
const DDL = [
  'CREATE TABLE workspaces (id text PRIMARY KEY NOT NULL)',
  'CREATE TABLE agents (id text PRIMARY KEY NOT NULL)',
  `CREATE TABLE agent_executions (
    id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE, status text NOT NULL DEFAULT 'completed'
  )`,
  'CREATE TABLE agent_tool_calls (id text PRIMARY KEY NOT NULL)',
  `CREATE TABLE chat_codex_tasks (
    id text PRIMARY KEY NOT NULL REFERENCES agent_tool_calls(id) ON DELETE CASCADE,
    workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    execution_id text NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE,
    goal text NOT NULL, project_directory text NOT NULL, model text NOT NULL, snapshot text NOT NULL,
    status text NOT NULL, answers text DEFAULT '[]' NOT NULL, pending_question text,
    activities text DEFAULT '[]' NOT NULL, steer_queue text DEFAULT '[]' NOT NULL, result text DEFAULT '' NOT NULL, error text,
    reported_at integer,
    worktree_path text, worktree_branch text, base_branch text, base_commit text,
    merge_status text DEFAULT 'not_attempted' NOT NULL, merge_error text,
    created_at integer DEFAULT (unixepoch() * 1000) NOT NULL, updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL
  )`,
  `CREATE TABLE chat_submissions (
    id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    chat_id text, execution_id text, message text NOT NULL, target text NOT NULL, reference text,
    output_message_id text, rendered_card text, rendered_task_cards text, delivery_fingerprint text,
    settled integer DEFAULT 0 NOT NULL, reported_at integer, error text,
    created_at integer DEFAULT (unixepoch() * 1000) NOT NULL, updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL
  )`,
  'CREATE TABLE agent_teams (id text PRIMARY KEY NOT NULL)',
  'CREATE TABLE agent_team_versions (id text PRIMARY KEY NOT NULL)',
  `CREATE TABLE agent_team_runs (
    id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    executor_category_id text NOT NULL REFERENCES agent_teams(id) ON DELETE RESTRICT,
    executor_category_version_id text NOT NULL REFERENCES agent_team_versions(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'queued', intent text NOT NULL, project_directory text NOT NULL,
    project_instructions text DEFAULT '[]' NOT NULL, mode text NOT NULL,
    authorized_commands text DEFAULT '[]' NOT NULL, scope_revision integer DEFAULT 1 NOT NULL,
    desired_control_state text DEFAULT 'none' NOT NULL, lang_graph_thread_id text NOT NULL UNIQUE,
    outcome text, worktree_base_path text, run_branch text,
    created_at integer DEFAULT (unixepoch() * 1000) NOT NULL, updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL,
    finished_at integer
  )`,
  `CREATE TABLE workflows (
    id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL, state text NOT NULL DEFAULT 'draft',
    created_at integer DEFAULT (unixepoch() * 1000) NOT NULL, updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL
  )`,
  'CREATE TABLE workflow_versions (id text PRIMARY KEY NOT NULL)',
  `CREATE TABLE workflow_runs (
    id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    workflow_id text NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    workflow_version_id text NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'queued', input text NOT NULL, result text, execution_state text, current_node_id text,
    created_at integer DEFAULT (unixepoch() * 1000) NOT NULL, updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL,
    finished_at integer
  )`,
];

const dbs: Database[] = [];

function setup(options?: { report?: 'reported' | 'busy' | 'unavailable'; env?: Record<string, string> }) {
  const db = createDb(':memory:');
  dbs.push(db);
  for (const statement of DDL) db.$client.exec(statement);
  db.$client.prepare('INSERT INTO workspaces (id) VALUES (?)').run(WORKSPACE_ID);
  db.$client.prepare('INSERT INTO agents (id) VALUES (?)').run('agt_system_helper_chat');
  db.$client.prepare('INSERT INTO agent_executions (id, workspace_id, agent_id) VALUES (?, ?, ?)').run(EXECUTION_ID, WORKSPACE_ID, 'agt_system_helper_chat');
  db.$client.prepare('INSERT INTO agent_tool_calls (id) VALUES (?)').run(TASK_ID);
  const reportActiveWorkProgress = vi.fn(async (_workspaceId: string, _executionId: string, _note: string): Promise<'reported' | 'busy' | 'unavailable'> => options?.report ?? 'reported');
  const getRunProgress = vi.fn(async () => ({
    phase: 'development' as const, nextStep: 'await_assignment_completion' as const,
    totalAssignments: 2, completedAssignments: 1, activeDeveloperIds: ['developer-1'], waitingReason: null, percent: 50,
  }));
  const service = new ChatProgressReportsService(
    db,
    { getRunProgress } as unknown as AgentTeamRuntimeService,
    { reportActiveWorkProgress } as unknown as AgentExecutionsService,
    { get: (key: string) => options?.env?.[key] } as unknown as ConfigService,
  );
  const tick = () => (service as unknown as { tick(): Promise<void> }).tick();
  return { db, service, tick, reportActiveWorkProgress, getRunProgress };
}

function insertTask(db: Database, status: string, activities: Array<Record<string, unknown>> = []) {
  db.$client.prepare(`INSERT INTO chat_codex_tasks (id, workspace_id, execution_id, goal, project_directory, model, snapshot, status, activities)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(TASK_ID, WORKSPACE_ID, EXECUTION_ID, '实现定时进展汇报', '/tmp/project', '', '{}', status, JSON.stringify(activities));
}

function insertTeamRun(db: Database, status: string, runId = 'trun_progress_test') {
  db.$client.prepare('INSERT INTO agent_teams (id) VALUES (?)').run('team_agent');
  db.$client.prepare('INSERT INTO agent_team_versions (id) VALUES (?)').run(`tver_${runId}`);
  db.$client.prepare(`INSERT INTO agent_team_runs (id, workspace_id, executor_category_id, executor_category_version_id, status, intent, project_directory, mode, lang_graph_thread_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(runId, WORKSPACE_ID, 'team_agent', `tver_${runId}`, status, '协作开发任务', '/tmp/project', 'implement_and_validate', `thread_${runId}`);
  db.$client.prepare('INSERT INTO chat_submissions (id, workspace_id, execution_id, message, target, reference) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`sub_${runId}`, WORKSPACE_ID, EXECUTION_ID, '协作开发任务', JSON.stringify({ kind: 'executor_category', executorCategoryId: 'team_agent' }), JSON.stringify({ kind: 'executor_category', executorCategoryId: 'team_agent', runId }));
}

function insertWorkflowRun(db: Database, status: string, runId = 'wrun_progress_test') {
  db.$client.prepare('INSERT INTO workflows (id, workspace_id, name) VALUES (?, ?, ?)').run(`wf_${runId}`, WORKSPACE_ID, '日报工作流');
  db.$client.prepare('INSERT INTO workflow_versions (id) VALUES (?)').run(`wver_${runId}`);
  db.$client.prepare('INSERT INTO workflow_runs (id, workspace_id, workflow_id, workflow_version_id, status, input, current_node_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(runId, WORKSPACE_ID, `wf_${runId}`, `wver_${runId}`, status, '{}', 'node_write');
  db.$client.prepare('INSERT INTO chat_submissions (id, workspace_id, execution_id, message, target, reference) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`sub_${runId}`, WORKSPACE_ID, EXECUTION_ID, '运行日报工作流', JSON.stringify({ kind: 'workflow', workflowVersionId: `wver_${runId}` }), JSON.stringify({ kind: 'workflow', workflowVersionId: `wver_${runId}`, runId }));
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.$client.close();
});

describe('ChatProgressReportsService', () => {
  it('reports a conversation with a running project task', async () => {
    const { db, tick, reportActiveWorkProgress } = setup();
    insertTask(db, 'running', [{ phase: 'claude.tool_started' }, { phase: 'claude.agent_message', text: '正在编写服务代码' }]);

    await tick();

    expect(reportActiveWorkProgress).toHaveBeenCalledTimes(1);
    const [workspaceId, executionId, note] = reportActiveWorkProgress.mock.calls[0] as [string, string, string];
    expect(workspaceId).toBe(WORKSPACE_ID);
    expect(executionId).toBe(EXECUTION_ID);
    expect(note).toContain(TASK_ID);
    expect(note).toContain('正在编写服务代码');
  });

  it('reports Chat-dispatched active executor and Workflow Runs', async () => {
    const { db, tick, reportActiveWorkProgress, getRunProgress } = setup();
    insertTeamRun(db, 'running');
    insertWorkflowRun(db, 'running');

    await tick();

    expect(reportActiveWorkProgress).toHaveBeenCalledTimes(1);
    const note = reportActiveWorkProgress.mock.calls[0]![2] as string;
    expect(note).toContain('trun_progress_test');
    expect(note).toContain('进度 50%');
    expect(note).toContain('日报工作流');
    expect(note).toContain('node_write');
    expect(getRunProgress).toHaveBeenCalledWith('trun_progress_test');
  });

  it('stays silent without active work', async () => {
    const { db, tick, reportActiveWorkProgress } = setup();
    insertTask(db, 'succeeded');
    insertTeamRun(db, 'succeeded', 'trun_done');
    insertWorkflowRun(db, 'failed', 'wrun_done');

    await tick();

    expect(reportActiveWorkProgress).not.toHaveBeenCalled();
  });

  it('does not treat waiting_for_input work as active progress', async () => {
    const { db, tick, reportActiveWorkProgress } = setup();
    insertTask(db, 'waiting_for_input');
    insertTeamRun(db, 'waiting_for_input', 'trun_waiting');

    await tick();

    expect(reportActiveWorkProgress).not.toHaveBeenCalled();
  });

  it('skips a tick whose visible progress is unchanged', async () => {
    const { db, tick, reportActiveWorkProgress } = setup();
    insertTask(db, 'running', [{ phase: 'claude.tool_started' }]);

    await tick();
    await tick();

    expect(reportActiveWorkProgress).toHaveBeenCalledTimes(1);

    db.$client.prepare(`UPDATE chat_codex_tasks SET activities = ? WHERE id = ?`)
      .run(JSON.stringify([{ phase: 'claude.tool_started' }, { phase: 'claude.agent_message', text: '新的进展' }]), TASK_ID);
    await tick();

    expect(reportActiveWorkProgress).toHaveBeenCalledTimes(2);
  });

  it('retries a busy conversation on the next tick', async () => {
    const { db, tick, reportActiveWorkProgress } = setup({ report: 'busy' });
    insertTask(db, 'running');

    await tick();
    await tick();

    expect(reportActiveWorkProgress).toHaveBeenCalledTimes(2);
  });

  it('stops reporting a cancelled conversation until its work changes', async () => {
    const { db, tick, reportActiveWorkProgress } = setup({ report: 'unavailable' });
    insertTask(db, 'running');

    await tick();
    await tick();
    expect(reportActiveWorkProgress).toHaveBeenCalledTimes(1);

    db.$client.prepare(`UPDATE chat_codex_tasks SET activities = ? WHERE id = ?`)
      .run(JSON.stringify([{ phase: 'claude.agent_message', text: '取消后仍在推进' }]), TASK_ID);
    await tick();

    expect(reportActiveWorkProgress).toHaveBeenCalledTimes(2);
  });

  it('resumes reporting from a clean signature after the work settles and restarts', async () => {
    const { db, tick, reportActiveWorkProgress } = setup();
    insertTask(db, 'running');

    await tick();
    expect(reportActiveWorkProgress).toHaveBeenCalledTimes(1);

    db.$client.prepare(`UPDATE chat_codex_tasks SET status = 'succeeded' WHERE id = ?`).run(TASK_ID);
    await tick();
    expect(reportActiveWorkProgress).toHaveBeenCalledTimes(1);

    db.$client.prepare(`UPDATE chat_codex_tasks SET status = 'running' WHERE id = ?`).run(TASK_ID);
    await tick();
    expect(reportActiveWorkProgress).toHaveBeenCalledTimes(2);
  });

  it('defaults the report interval to five minutes', () => {
    const { service } = setup();
    expect(service.intervalSeconds).toBe(DEFAULT_PROGRESS_NOTE_INTERVAL_SECONDS);
    expect(DEFAULT_PROGRESS_NOTE_INTERVAL_SECONDS).toBe(300);
  });

  it('reads the report interval from CHAT_PROGRESS_NOTE_INTERVAL_SECONDS', () => {
    expect(setup({ env: { CHAT_PROGRESS_NOTE_INTERVAL_SECONDS: '600' } }).service.intervalSeconds).toBe(600);
  });

  it('falls back to the default interval for an invalid value', () => {
    expect(setup({ env: { CHAT_PROGRESS_NOTE_INTERVAL_SECONDS: 'soon' } }).service.intervalSeconds).toBe(DEFAULT_PROGRESS_NOTE_INTERVAL_SECONDS);
    expect(setup({ env: { CHAT_PROGRESS_NOTE_INTERVAL_SECONDS: '-30' } }).service.intervalSeconds).toBe(DEFAULT_PROGRESS_NOTE_INTERVAL_SECONDS);
  });
});

describe('buildActiveWorkNote / activeWorkSignature', () => {
  const items: ActiveWorkItem[] = [
    { kind: 'task', id: 'acall_1', goal: '写代码', stage: 'working', activityCount: 3, progressText: '正在修改服务' },
    { kind: 'executor_category', id: 'trun_1', intent: '协作任务', status: 'running', progress: null },
    { kind: 'workflow', id: 'wrun_1', workflowName: '日报', status: 'paused', currentNodeId: null },
  ];

  it('summarizes every active item briefly without internal detail', () => {
    const note = buildActiveWorkNote(items);
    expect(note).toContain('[活跃工作进展提醒]');
    expect(note).toContain('约每 5 分钟提醒一次');
    expect(note).toContain('acall_1');
    expect(note).toContain('trun_1');
    expect(note).toContain('wrun_1');
    expect(note).toContain('不要向用户复述本提醒本身');
  });

  it('labels a non-minute interval in seconds', () => {
    expect(buildActiveWorkNote(items, 90)).toContain('约每 90 秒提醒一次');
  });

  it('changes only when a visible field changes', () => {
    const base = activeWorkSignature(items);
    expect(activeWorkSignature(items)).toBe(base);
    const progressed = items.map((item) => item.kind === 'task' ? { ...item, activityCount: item.activityCount + 1 } : item);
    expect(activeWorkSignature(progressed)).not.toBe(base);
    const settled = items.map((item) => item.kind === 'executor_category' ? { ...item, status: 'succeeded' } : item);
    expect(activeWorkSignature(settled)).not.toBe(base);
  });
});
