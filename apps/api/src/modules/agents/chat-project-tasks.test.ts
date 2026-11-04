import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { createDb, type Database } from '@worklite/db';
import { ChatProjectTasksService, extractTaskResult, settleChatProjectTask } from './chat-project-tasks.service';
import type { ProjectExecutorService } from './project-executor.service';
import type { ChatAttachmentsService } from './chat-attachments.service';

// No test here sends a pasted image, so the attachment store only has to exist as a collaborator.
const noAttachments = { open: () => { throw new Error('no attachment'); }, load: async () => null } as unknown as ChatAttachmentsService;

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
      execution_authorization text, capability_snapshot text, project_directory text,
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
      activities text DEFAULT '[]' NOT NULL, steer_queue text DEFAULT '[]' NOT NULL, result text DEFAULT '' NOT NULL, error text,
      reported_at integer,
      worktree_path text, worktree_branch text, base_branch text, base_commit text,
      merge_status text DEFAULT 'not_attempted' NOT NULL, merge_error text,
      created_at integer DEFAULT (unixepoch() * 1000) NOT NULL, updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL
    )`,
    `CREATE TABLE chat_codex_operations (
      key text PRIMARY KEY NOT NULL, task_id text NOT NULL REFERENCES chat_codex_tasks(id) ON DELETE CASCADE,
      task_key text NOT NULL, operation_key text NOT NULL, tool_name text NOT NULL, input_fingerprint text NOT NULL,
      status text NOT NULL, command_id text, result text, failure_reason text,
      created_at integer DEFAULT (unixepoch() * 1000) NOT NULL, updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL
    )`,
    `CREATE TABLE chat_bot_configurations (
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, revision integer NOT NULL,
      extension_prompt text DEFAULT '' NOT NULL, summarize_prompt text DEFAULT '' NOT NULL,
      default_executor text DEFAULT 'claude' NOT NULL, default_executor_models text DEFAULT '{}' NOT NULL,
      project_task_mcp_server_ids text DEFAULT '[]' NOT NULL,
      provider_id text, model text NOT NULL, skill_ids text NOT NULL, mcp_server_ids text NOT NULL,
      created_at integer DEFAULT (unixepoch() * 1000) NOT NULL,
      PRIMARY KEY (workspace_id, revision)
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
    return { service: new ChatProjectTasksService(db, executors as unknown as ProjectExecutorService, noAttachments), repository };
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

  it('rejects steering a task that is no longer running', async () => {
    const { service, repository } = setup();
    const task = await service.capture(WORKSPACE_ID, EXECUTION_ID, 'acall_change', {
      goal: '修改 README 标题', projectDirectory: repository,
    });
    await service.cancel(task.id);
    await expect(service.steer(WORKSPACE_ID, task.id, '改成只读调查')).rejects.toThrow('This project task is not running');
  });

  it('delivers a steer instruction into the live round when the executor accepts it', async () => {
    const { repository } = setup();
    const db = createDb(':memory:');
    dbs.push(db);
    for (const statement of DDL) db.$client.exec(statement);
    db.$client.prepare('INSERT INTO workspaces (id) VALUES (?)').run(WORKSPACE_ID);
    db.$client.prepare('INSERT INTO agents (id) VALUES (?)').run('agt_system_helper_chat');
    db.$client.prepare('INSERT INTO agent_executions (id, workspace_id, agent_id, capability_snapshot) VALUES (?, ?, ?, ?)')
      .run(EXECUTION_ID, WORKSPACE_ID, 'agt_system_helper_chat', CAPABILITIES);
    db.$client.prepare('INSERT INTO agent_tool_calls (id) VALUES (?)').run('acall_live');
    let releaseExecutor!: () => void;
    const held = new Promise<void>((resolve) => { releaseExecutor = resolve; });
    let deliverCalledWith: string | undefined;
    const executors = {
      captureLaunch: async () => ({ executor: 'claude' as const, commandArguments: [], baseUrl: 'http://127.0.0.1:23392', model: null }),
      execute: async (request: { steerPort?: { deliver?: (text: string) => Promise<boolean> } }) => {
        if (request.steerPort) request.steerPort.deliver = async (text) => { deliverCalledWith = text; return true; };
        await held;
        return '{"status":"succeeded","summary":"done"}';
      },
    };
    const service = new ChatProjectTasksService(db, executors as unknown as ProjectExecutorService, noAttachments);
    const task = await service.capture(WORKSPACE_ID, EXECUTION_ID, 'acall_live', { goal: '调查并修复问题', projectDirectory: repository });

    const completion = service.run(task.id, async () => undefined);
    // Yield so execute() reaches executors.execute() and registers the live steer port before steering.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const steered = await service.steer(WORKSPACE_ID, task.id, '改成先只读调查，不要直接改文件');
    expect(deliverCalledWith).toBe('改成先只读调查，不要直接改文件');
    expect(steered.steerQueue).toHaveLength(1);
    expect(steered.steerQueue[0]).toMatchObject({ status: 'delivered', text: '改成先只读调查，不要直接改文件' });

    releaseExecutor();
    const settled = await completion;
    expect(settled.status).toBe('succeeded');
    // A delivered instruction is retained as historical evidence, not replayed into the next round.
    expect(settled.steerQueue).toHaveLength(1);
    expect(settled.steerQueue[0]!.status).toBe('delivered');
  });

  it('keeps the round alive across a live Claude question: reports the wait, then the answer continues the same round', async () => {
    const { repository } = setup();
    const db = createDb(':memory:');
    dbs.push(db);
    for (const statement of DDL) db.$client.exec(statement);
    db.$client.prepare('INSERT INTO workspaces (id) VALUES (?)').run(WORKSPACE_ID);
    db.$client.prepare('INSERT INTO agents (id) VALUES (?)').run('agt_system_helper_chat');
    db.$client.prepare('INSERT INTO agent_executions (id, workspace_id, agent_id, capability_snapshot) VALUES (?, ?, ?, ?)')
      .run(EXECUTION_ID, WORKSPACE_ID, 'agt_system_helper_chat', CAPABILITIES);
    db.$client.prepare('INSERT INTO agent_tool_calls (id) VALUES (?)').run('acall_ask');
    let executeCalls = 0;
    let received: string | undefined;
    const executors = {
      captureLaunch: async () => ({ executor: 'claude' as const, commandArguments: [], baseUrl: 'http://127.0.0.1:23392', model: null }),
      execute: async (request: { onQuestion?: (question: string) => Promise<string | undefined> }) => {
        executeCalls += 1;
        received = await request.onQuestion!('用哪个方案？');
        return `{"status":"succeeded","summary":"按 ${received} 完成"}`;
      },
    };
    const service = new ChatProjectTasksService(db, executors as unknown as ProjectExecutorService, noAttachments);
    const task = await service.capture(WORKSPACE_ID, EXECUTION_ID, 'acall_ask', { goal: '修复问题', projectDirectory: repository });
    const waitingReports: string[] = [];
    const completion = service.run(task.id, async () => undefined, undefined, (waiting) => { waitingReports.push(waiting.pendingQuestion!.question); });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const waiting = service.view(task.id, WORKSPACE_ID);
    expect(waiting.status).toBe('waiting_for_input');
    expect(waitingReports).toEqual(['用哪个方案？']);

    await service.answer(WORKSPACE_ID, task.id, { questionId: waiting.pendingQuestion!.id, answer: 'A' }, () => undefined);
    const settled = await completion;
    expect(received).toBe('A');
    expect(executeCalls).toBe(1);
    expect(settled.status).toBe('succeeded');
    expect(settled.result).toBe('按 A 完成');
    expect(settled.reportedAt).toBeNull();
  });

  it('ends a live Claude question wait when the task is cancelled', async () => {
    const { repository } = setup();
    const db = createDb(':memory:');
    dbs.push(db);
    for (const statement of DDL) db.$client.exec(statement);
    db.$client.prepare('INSERT INTO workspaces (id) VALUES (?)').run(WORKSPACE_ID);
    db.$client.prepare('INSERT INTO agents (id) VALUES (?)').run('agt_system_helper_chat');
    db.$client.prepare('INSERT INTO agent_executions (id, workspace_id, agent_id, capability_snapshot) VALUES (?, ?, ?, ?)')
      .run(EXECUTION_ID, WORKSPACE_ID, 'agt_system_helper_chat', CAPABILITIES);
    db.$client.prepare('INSERT INTO agent_tool_calls (id) VALUES (?)').run('acall_ask_cancel');
    let received: string | undefined = 'unset';
    const executors = {
      captureLaunch: async () => ({ executor: 'claude' as const, commandArguments: [], baseUrl: 'http://127.0.0.1:23392', model: null }),
      execute: async (request: { onQuestion?: (question: string) => Promise<string | undefined>; signal: AbortSignal }) => {
        received = await request.onQuestion!('用哪个方案？');
        request.signal.throwIfAborted();
        return '{"status":"succeeded","summary":"never"}';
      },
    };
    const service = new ChatProjectTasksService(db, executors as unknown as ProjectExecutorService, noAttachments);
    const task = await service.capture(WORKSPACE_ID, EXECUTION_ID, 'acall_ask_cancel', { goal: '修复问题', projectDirectory: repository });
    const completion = service.run(task.id, async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.view(task.id, WORKSPACE_ID).status).toBe('waiting_for_input');

    const cancelled = await service.cancel(task.id);
    expect(received).toBeUndefined();
    expect(cancelled.status).toBe('cancelled');
    expect((await completion).status).toBe('cancelled');
  });

  it('queues a steer instruction and runs another round within the same background execution when the executor has no live channel', async () => {
    const { repository } = setup();
    const db = createDb(':memory:');
    dbs.push(db);
    for (const statement of DDL) db.$client.exec(statement);
    db.$client.prepare('INSERT INTO workspaces (id) VALUES (?)').run(WORKSPACE_ID);
    db.$client.prepare('INSERT INTO agents (id) VALUES (?)').run('agt_system_helper_chat');
    db.$client.prepare('INSERT INTO agent_executions (id, workspace_id, agent_id, capability_snapshot) VALUES (?, ?, ?, ?)')
      .run(EXECUTION_ID, WORKSPACE_ID, 'agt_system_helper_chat', CAPABILITIES);
    db.$client.prepare('INSERT INTO agent_tool_calls (id) VALUES (?)').run('acall_claude');
    let releaseFirstRound!: () => void;
    const held = new Promise<void>((resolve) => { releaseFirstRound = resolve; });
    let secondRoundInput: string | undefined;
    let round = 0;
    const executors = {
      captureLaunch: async () => ({ executor: 'claude' as const, commandArguments: [], baseUrl: 'http://127.0.0.1:23392', model: null }),
      // Claude Code never populates request.steerPort.deliver, matching its real behavior.
      execute: async (request: { input: string }) => {
        round += 1;
        if (round === 1) { await held; return '{"status":"succeeded","summary":"first round done"}'; }
        secondRoundInput = request.input;
        return '{"status":"succeeded","summary":"second round done"}';
      },
    };
    const service = new ChatProjectTasksService(db, executors as unknown as ProjectExecutorService, noAttachments);
    const task = await service.capture(WORKSPACE_ID, EXECUTION_ID, 'acall_claude', { goal: '调查并修复问题', projectDirectory: repository });

    const completion = service.run(task.id, async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The steer lands after round 1's goal was already built, so it cannot join round 1; because
    // round 1's own executor never offers a live channel, it also cannot be delivered. It queues.
    const steered = await service.steer(WORKSPACE_ID, task.id, '先只调查，不要改文件');
    expect(steered.steerQueue[0]).toMatchObject({ status: 'queued', text: '先只调查，不要改文件' });

    releaseFirstRound();
    // The background execution notices the still-queued instruction once round 1 settles and runs
    // a second round automatically, inside the same run() call, rather than leaving the task
    // succeeded with a stranded instruction that needs the user to re-dispatch.
    const settled = await completion;
    expect(settled.status).toBe('succeeded');
    expect(settled.result).toBe('second round done');
    expect(settled.steerQueue[0]!.status).toBe('consumed');
    expect(round).toBe(2);
    expect(JSON.parse(secondRoundInput!)).toMatchObject({ userCorrections: ['先只调查，不要改文件'] });
  });

  // A service wired to a scripted executor; `execute` receives each round's request.
  function scripted(callId: string, execute: (request: { input: string; signal: AbortSignal; steerPort?: { deliver?: (text: string) => Promise<boolean> } }) => Promise<string>) {
    const db = createDb(':memory:');
    dbs.push(db);
    for (const statement of DDL) db.$client.exec(statement);
    db.$client.prepare('INSERT INTO workspaces (id) VALUES (?)').run(WORKSPACE_ID);
    db.$client.prepare('INSERT INTO agents (id) VALUES (?)').run('agt_system_helper_chat');
    db.$client.prepare('INSERT INTO agent_executions (id, workspace_id, agent_id, capability_snapshot) VALUES (?, ?, ?, ?)')
      .run(EXECUTION_ID, WORKSPACE_ID, 'agt_system_helper_chat', CAPABILITIES);
    db.$client.prepare('INSERT INTO agent_tool_calls (id) VALUES (?)').run(callId);
    const executors = {
      captureLaunch: async () => ({ executor: 'claude' as const, commandArguments: [], baseUrl: 'http://127.0.0.1:23392', model: null }),
      execute,
    };
    return { db, service: new ChatProjectTasksService(db, executors as unknown as ProjectExecutorService, noAttachments) };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const done = (summary: string) => JSON.stringify({ status: 'succeeded', summary });
  const gate = () => { let open!: () => void; const promise = new Promise<void>((resolve) => { open = resolve; }); return { promise, open }; };

  it('records each appended instruction with a per-task sequence number, source and timestamp', async () => {
    const { repository } = setup();
    const hold = gate();
    const { service } = scripted('acall_seq', async () => { await hold.promise; return done('ok'); });
    const task = await service.capture(WORKSPACE_ID, EXECUTION_ID, 'acall_seq', { goal: '调查并修复问题', projectDirectory: repository });
    const completion = service.run(task.id, async () => undefined);
    await tick();

    await service.steer(WORKSPACE_ID, task.id, '  第一条  ');
    const view = await service.steer(WORKSPACE_ID, task.id, '第二条');
    expect(view.steerQueue.map((entry) => [entry.seq, entry.source, entry.text, entry.status])).toEqual([[1, 'user', '第一条', 'queued'], [2, 'user', '第二条', 'queued']]);
    expect(view.steerQueue.every((entry) => !Number.isNaN(Date.parse(entry.createdAt)) && entry.consumedAt === undefined)).toBe(true);
    // The instructions are also visible in the progress stream.
    expect(view.activities.filter((activity) => activity.phase === 'steer.submitted').map((activity) => activity.seq)).toEqual([1, 2]);

    hold.open();
    await completion;
  });

  it('rejects an empty or oversized instruction', async () => {
    const { repository } = setup();
    const hold = gate();
    const { service } = scripted('acall_bad_text', async () => { await hold.promise; return done('ok'); });
    const task = await service.capture(WORKSPACE_ID, EXECUTION_ID, 'acall_bad_text', { goal: '调查', projectDirectory: repository });
    const completion = service.run(task.id, async () => undefined);
    await tick();
    await expect(service.steer(WORKSPACE_ID, task.id, '   ')).rejects.toThrow('text is required.');
    await expect(service.steer(WORKSPACE_ID, task.id, 'x'.repeat(4001))).rejects.toThrow('at most 4000');
    hold.open();
    await completion;
  });

  it('injects queued instructions once, in order, at the next round boundary and keeps the goal unchanged', async () => {
    const { repository } = setup();
    const firstRound = gate();
    const secondRound = gate();
    const inputs: Array<Record<string, unknown>> = [];
    const { service } = scripted('acall_boundary', async (request) => {
      inputs.push(JSON.parse(request.input));
      if (inputs.length === 1) { await firstRound.promise; return done('round 1'); }
      if (inputs.length === 2) { await secondRound.promise; return done('round 2'); }
      return done('round 3');
    });
    const task = await service.capture(WORKSPACE_ID, EXECUTION_ID, 'acall_boundary', { goal: '主目标不变', projectDirectory: repository });
    const completion = service.run(task.id, async () => undefined);
    await tick();

    await service.steer(WORKSPACE_ID, task.id, '补充 A');
    await service.steer(WORKSPACE_ID, task.id, '补充 B');
    expect(inputs).toHaveLength(1);
    // Round 1 was already built without them, and the live tool call is never interrupted.
    expect(inputs[0]).not.toHaveProperty('userCorrections');

    firstRound.open();
    await tick(); await tick();
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toMatchObject({ goal: '主目标不变', userCorrections: ['补充 A', '补充 B'] });
    const afterBoundary = service.view(task.id);
    expect(afterBoundary.steerQueue.map((entry) => [entry.seq, entry.status, entry.consumedTurn])).toEqual([[1, 'consumed', 2], [2, 'consumed', 2]]);
    expect(afterBoundary.steerQueue.every((entry) => !Number.isNaN(Date.parse(entry.consumedAt!)))).toBe(true);
    expect(afterBoundary.activities.filter((activity) => activity.phase === 'steer.applied').map((activity) => [activity.seq, activity.round])).toEqual([[1, 2], [2, 2]]);

    // A later steer goes to round 3 alone: earlier instructions are never injected again.
    await service.steer(WORKSPACE_ID, task.id, '补充 C');
    secondRound.open();
    const settled = await completion;
    expect(inputs).toHaveLength(3);
    expect(inputs[2]).toMatchObject({ goal: '主目标不变', userCorrections: ['补充 C'] });
    expect(settled.steerQueue.map((entry) => [entry.seq, entry.status, entry.consumedTurn])).toEqual([[1, 'consumed', 2], [2, 'consumed', 2], [3, 'consumed', 3]]);
    expect(settled.status).toBe('succeeded');
    expect(settled.goal).toBe('主目标不变');
  });

  it('marks a live-delivered instruction applied in the current round and never injects it again', async () => {
    const { repository } = setup();
    const hold = gate();
    const inputs: Array<Record<string, unknown>> = [];
    const { service } = scripted('acall_delivered', async (request) => {
      inputs.push(JSON.parse(request.input));
      if (request.steerPort) request.steerPort.deliver = async () => true;
      await hold.promise;
      return done('ok');
    });
    const task = await service.capture(WORKSPACE_ID, EXECUTION_ID, 'acall_delivered', { goal: '目标', projectDirectory: repository });
    const completion = service.run(task.id, async () => undefined);
    await tick();

    const view = await service.steer(WORKSPACE_ID, task.id, '实时纠正');
    expect(view.steerQueue[0]).toMatchObject({ seq: 1, status: 'delivered', consumedTurn: 1 });
    expect(view.steerQueue[0]!.consumedAt).toBeTruthy();
    hold.open();
    const settled = await completion;
    expect(inputs).toHaveLength(1);
    expect(settled.steerQueue[0]!.status).toBe('delivered');
  });

  it('refuses instructions for settled and question-waiting tasks with a specific reason', async () => {
    const { repository } = setup();
    const { service, db } = scripted('acall_refuse', async () => done('finished'));
    const task = await service.capture(WORKSPACE_ID, EXECUTION_ID, 'acall_refuse', { goal: '目标', projectDirectory: repository });

    db.$client.prepare("UPDATE chat_codex_tasks SET status = 'waiting_for_input' WHERE id = ?").run(task.id);
    await expect(service.steer(WORKSPACE_ID, task.id, '补充')).rejects.toThrow('waiting for an answer');
    for (const status of ['succeeded', 'failed', 'cancelled']) {
      db.$client.prepare('UPDATE chat_codex_tasks SET status = ? WHERE id = ?').run(status, task.id);
      await expect(service.steer(WORKSPACE_ID, task.id, '补充')).rejects.toThrow(`is not running, so it cannot accept a steering instruction: it already ${status}.`);
    }
    expect(service.view(task.id).steerQueue).toEqual([]);
  });

  it('never consumes a queued instruction once the task is cancelled', async () => {
    const { repository } = setup();
    const inputs: string[] = [];
    const { service } = scripted('acall_cancelled', (request) => {
      inputs.push(request.input);
      return new Promise<string>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const task = await service.capture(WORKSPACE_ID, EXECUTION_ID, 'acall_cancelled', { goal: '目标', projectDirectory: repository });
    const completion = service.run(task.id, async () => undefined);
    await tick();
    await service.steer(WORKSPACE_ID, task.id, '取消前排队');

    await service.cancel(task.id);
    const settled = await completion;
    expect(settled.status).toBe('cancelled');
    expect(inputs).toHaveLength(1);
    expect(settled.steerQueue[0]).toMatchObject({ status: 'queued' });
    expect(settled.steerQueue[0]!.consumedAt).toBeUndefined();
    await expect(service.steer(WORKSPACE_ID, task.id, '取消后追加')).rejects.toThrow('it already cancelled');
    // Re-running a cancelled task is a no-op, so nothing can consume the leftover instruction.
    await service.run(task.id, async () => undefined);
    expect(inputs).toHaveLength(1);
    expect(service.view(task.id).steerQueue[0]!.status).toBe('queued');
  });

  it('reads historical tasks whose steer entries predate seq and consumedTurn, and keeps numbering after them', async () => {
    const { repository } = setup();
    const hold = gate();
    const { service, db } = scripted('acall_legacy', async () => { await hold.promise; return done('ok'); });
    const task = await service.capture(WORKSPACE_ID, EXECUTION_ID, 'acall_legacy', { goal: '目标', projectDirectory: repository });
    db.$client.prepare('UPDATE chat_codex_tasks SET steer_queue = ? WHERE id = ?')
      .run(JSON.stringify([{ id: 'steer_old', text: '历史纠偏', createdAt: '2026-10-21T00:00:01.000Z', status: 'delivered' }]), task.id);
    expect(service.view(task.id).steerQueue).toEqual([{ id: 'steer_old', text: '历史纠偏', createdAt: '2026-10-21T00:00:01.000Z', status: 'delivered' }]);

    const completion = service.run(task.id, async () => undefined);
    await tick();
    const view = await service.steer(WORKSPACE_ID, task.id, '新的补充');
    expect(view.steerQueue.map((entry) => entry.seq)).toEqual([undefined, 2]);
    hold.open();
    await completion;
  });

  it('keeps steer bookkeeping out of the derived stage and the progress text', async () => {
    const { repository } = setup();
    const hold = gate();
    const { service } = scripted('acall_stage', async () => { await hold.promise; return done('ok'); });
    const task = await service.capture(WORKSPACE_ID, EXECUTION_ID, 'acall_stage', { goal: '目标', projectDirectory: repository });
    const completion = service.run(task.id, async () => undefined);
    await tick();
    const view = await service.steer(WORKSPACE_ID, task.id, '补充');
    expect(view.stage).toBe('starting');
    expect(view.progressText).toBe('');
    hold.open();
    await completion;
  });
});
