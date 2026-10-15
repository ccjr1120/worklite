import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { createDb, type Database } from '@worklite/db';
import { ChatProjectTasksService, extractTaskResult, settleChatProjectTask } from './chat-project-tasks.service';
import type { ProjectExecutorService } from './project-executor.service';
import type { WorkspaceResourcesService } from '../teams/team-resources.service';

describe('extractTaskResult', () => {
  it('parses a bare succeeded result', () => {
    expect(extractTaskResult('{"status":"succeeded","summary":"done"}')).toEqual({ status: 'succeeded', summary: 'done' });
  });

  it('parses a waiting_for_input result', () => {
    expect(extractTaskResult('{"status":"waiting_for_input","pendingInput":{"question":"which file?"}}'))
      .toEqual({ status: 'waiting_for_input', question: 'which file?' });
  });

  it('parses a fully fenced result', () => {
    expect(extractTaskResult('```json\n{"status":"succeeded","summary":"done"}\n```')).toEqual({ status: 'succeeded', summary: 'done' });
  });

  it('extracts a fenced result surrounded by prose', () => {
    const output = '工作已完成，结果如下：\n```json\n{"status":"succeeded","summary":"已修复解析"}\n```\n以上。';
    expect(extractTaskResult(output)).toEqual({ status: 'succeeded', summary: '已修复解析' });
  });

  it('extracts a result when prose follows the fence', () => {
    const output = '```json\n{"status":"succeeded","summary":"已提交"}\n```\n\n## 下一步\n等你确认。';
    expect(extractTaskResult(output)).toEqual({ status: 'succeeded', summary: '已提交' });
  });

  it('extracts an unfenced result embedded in prose', () => {
    expect(extractTaskResult('完成了。{"status":"succeeded","summary":"ok"} 如有问题请继续。'))
      .toEqual({ status: 'succeeded', summary: 'ok' });
  });

  it('skips JSON values without the result shape and keeps scanning', () => {
    const output = '配置示例 {"status":"draft","note":"ignore me"}，最终结果：{"status":"succeeded","summary":"real"}';
    expect(extractTaskResult(output)).toEqual({ status: 'succeeded', summary: 'real' });
  });

  it('tolerates raw control characters inside string values', () => {
    const output = '{"status":"succeeded","summary":"第一行\n第二行"}';
    expect(extractTaskResult(output)).toEqual({ status: 'succeeded', summary: '第一行\n第二行' });
  });

  it('returns null for truncated JSON', () => {
    expect(extractTaskResult('{"status":"succeeded","summary":"写了一半')).toBeNull();
  });

  it('returns null for prose without any result JSON', () => {
    expect(extractTaskResult('调研进展汇报：仍在阅读架构文档。')).toBeNull();
  });

  it('returns null for JSON with an unsupported status', () => {
    expect(extractTaskResult('{"status":"failed","error":"boom"}')).toBeNull();
  });
});

describe('settleChatProjectTask', () => {
  it('settles a clean result without diagnostics', () => {
    expect(settleChatProjectTask('{"status":"succeeded","summary":"done"}', []))
      .toEqual({ status: 'succeeded', result: 'done', error: null });
  });

  it('settles waiting_for_input from the output', () => {
    expect(settleChatProjectTask('{"status":"waiting_for_input","pendingInput":{"question":"授权吗？"}}', []))
      .toEqual({ status: 'waiting_for_input', question: '授权吗？' });
  });

  it('recovers the result from the latest activity message when the final output is prose', () => {
    const activities = ['早期汇报', '{"status":"succeeded","summary":"五项需求全部完成"}'];
    const settlement = settleChatProjectTask('调研进展汇报：仍在进行中。', activities.reverse());
    expect(settlement.status).toBe('succeeded');
    expect(settlement).toMatchObject({ result: '五项需求全部完成' });
    expect(settlement.status === 'succeeded' && settlement.error).toMatch('解析降级');
  });

  it('recovers waiting_for_input from an activity message', () => {
    const settlement = settleChatProjectTask('我还需要确认一件事', ['{"status":"waiting_for_input","pendingInput":{"question":"选 A 还是 B？"}}']);
    expect(settlement).toEqual({ status: 'waiting_for_input', question: '选 A 还是 B？' });
  });

  it('degrades to a succeeded task holding the raw output when nothing parses', () => {
    const settlement = settleChatProjectTask('执行器只返回了散文。', []);
    expect(settlement.status).toBe('succeeded');
    expect(settlement).toMatchObject({ result: '执行器只返回了散文。' });
    expect(settlement.status === 'succeeded' && settlement.error).toMatch('解析降级');
  });

  it('degrades truncated JSON output instead of failing', () => {
    const settlement = settleChatProjectTask('{"status":"succeeded","summary":"截断', []);
    expect(settlement.status).toBe('succeeded');
    expect(settlement.status === 'succeeded' && settlement.error).toMatch('解析降级');
  });
});

// capture() runs against an in-memory database with the minimal tables it touches and accepts
// both Git repositories and workspace directories without mutating their Git state.
describe('ChatProjectTasksService.capture workspace behavior', () => {
  const WORKSPACE_ID = 'workspace_personal';
  const EXECUTION_ID = 'aex_capture_test';
  const CAPABILITIES = JSON.stringify({
    revision: 1,
    agent: { id: 'agt_system_helper_chat', providerId: null, model: '', systemPrompt: '' },
    skills: [], mcpServers: [],
  });
  const DDL = [
    'CREATE TABLE workspaces (id text PRIMARY KEY NOT NULL)',
    'CREATE TABLE agents (id text PRIMARY KEY NOT NULL)',
    `CREATE TABLE agent_executions (
      execution_authorization text, capability_snapshot text,
      id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'running', phase text NOT NULL DEFAULT 'model', error_code text,
      model_messages text DEFAULT '[]' NOT NULL, display_messages text DEFAULT '[]' NOT NULL, plan text DEFAULT '[]' NOT NULL,
      pending_question text, context_dropped integer DEFAULT 0 NOT NULL, error text,
      created_at integer DEFAULT (unixepoch() * 1000) NOT NULL, updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL
    )`,
    'CREATE TABLE agent_tool_calls (id text PRIMARY KEY NOT NULL)',
    `CREATE TABLE chat_codex_tasks (
      id text PRIMARY KEY NOT NULL REFERENCES agent_tool_calls(id) ON DELETE CASCADE,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      execution_id text NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE,
      goal text NOT NULL, project_directory text NOT NULL, model text NOT NULL, snapshot text NOT NULL,
      status text NOT NULL, answers text DEFAULT '[]' NOT NULL, pending_question text,
      activities text DEFAULT '[]' NOT NULL, result text DEFAULT '' NOT NULL, error text,
      reported_at integer,
      worktree_path text, worktree_branch text, base_branch text, base_commit text,
      merge_status text DEFAULT 'not_attempted' NOT NULL, merge_error text,
      created_at integer DEFAULT (unixepoch() * 1000) NOT NULL, updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL
    )`,
  ];

  const dbs: Database[] = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.$client.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function setup(): { service: ChatProjectTasksService; repository: string } {
    const db = createDb(':memory:');
    dbs.push(db);
    for (const statement of DDL) db.$client.exec(statement);
    db.$client.prepare('INSERT INTO workspaces (id) VALUES (?)').run(WORKSPACE_ID);
    db.$client.prepare('INSERT INTO agents (id) VALUES (?)').run('agt_system_helper_chat');
    db.$client.prepare('INSERT INTO agent_executions (id, workspace_id, agent_id, capability_snapshot) VALUES (?, ?, ?, ?)')
      .run(EXECUTION_ID, WORKSPACE_ID, 'agt_system_helper_chat', CAPABILITIES);
    for (const callId of ['acall_readonly', 'acall_change', 'acall_nongit', 'acall_bad']) {
      db.$client.prepare('INSERT INTO agent_tool_calls (id) VALUES (?)').run(callId);
    }
    const root = mkdtempSync(join(tmpdir(), 'worklite-capture-'));
    directories.push(root);
    const repository = join(root, 'project');
    execFileSync('git', ['init', repository]);
    execFileSync('git', ['-C', repository, '-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'init']);
    const executors = {
      captureLaunch: async () => ({ executor: 'claude' as const, commandArguments: [], baseUrl: 'http://127.0.0.1:23392', model: null }),
    };
    const resources = { workflowMcpRuntimes: async () => [] } as unknown as WorkspaceResourcesService;
    return { service: new ChatProjectTasksService(db, executors as unknown as ProjectExecutorService, resources), repository };
  }

  function gitBranches(repository: string): string {
    return execFileSync('git', ['-C', repository, 'branch', '--list', 'worklite/*'], { encoding: 'utf8' }).trim();
  }

  it('runs a read-only task at the workspace root without selecting a Git strategy', async () => {
    const { service, repository } = setup();
    const task = await service.capture(WORKSPACE_ID, EXECUTION_ID, 'acall_readonly', {
      goal: '调查 worktree 创建逻辑在哪里', projectDirectory: repository, readOnly: true,
    });

    expect(task.worktreePath).toBeNull();
    expect(task.worktreeBranch).toBeNull();
    expect(task.mergeStatus).toBe('not_attempted');
    expect(task.snapshot.readOnly).toBe(true);
    expect(gitBranches(repository)).toBe('');
  });

  it('does not force a worktree for a default change task', async () => {
    const { service, repository } = setup();
    const task = await service.capture(WORKSPACE_ID, EXECUTION_ID, 'acall_change', {
      goal: '修改 README 标题', projectDirectory: repository,
    });

    expect(task.worktreePath).toBeNull();
    expect(task.worktreeBranch).toBeNull();
    expect(task.mergeStatus).toBe('not_attempted');
    expect(task.snapshot.readOnly).toBe(false);
    expect(gitBranches(repository)).toBe('');
  });

  it('accepts a non-git workspace without a special merge status', async () => {
    const { service } = setup();
    const plain = mkdtempSync(join(tmpdir(), 'worklite-capture-plain-'));
    directories.push(plain);
    const task = await service.capture(WORKSPACE_ID, EXECUTION_ID, 'acall_nongit', {
      goal: '查看目录结构', projectDirectory: plain, readOnly: true,
    });

    expect(task.worktreePath).toBeNull();
    expect(task.mergeStatus).toBe('not_attempted');
    expect(task.snapshot.readOnly).toBe(true);
  });

  it('rejects a non-boolean readOnly', async () => {
    const { service, repository } = setup();
    await expect(service.capture(WORKSPACE_ID, EXECUTION_ID, 'acall_bad', {
      goal: '调查', projectDirectory: repository, readOnly: 'yes',
    })).rejects.toThrow('readOnly must be a boolean.');
  });
});
