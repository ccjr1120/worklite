import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, initializeDatabase, externalChats, chatSubmissions, wechatEvents, type Database } from '@worklite/db';
import type { AgentExecutionView } from '@worklite/contracts';
import { monitorFailureState, truncateWechatText, WECHAT_CONNECT_FAILURE_ESCALATION_MS, WechatService } from './wechat.service';
import type { FetchLike } from './ilink';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (condition: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for the condition.');
    await delay(50);
  }
};

// A thenable stand-in for the drizzle query chains the service touches while idling.
function emptyQuery(): unknown {
  const query = {
    from: () => query, where: () => query, orderBy: () => query, limit: () => query,
    set: () => query, values: () => query, onConflictDoNothing: () => query,
    then: (onFulfilled?: (value: never[]) => unknown) => Promise.resolve([]).then(onFulfilled),
  };
  return query;
}

describe('truncateWechatText', () => {
  it('leaves a reply under the platform limit untouched', () => {
    const text = '普通回复';
    expect(truncateWechatText(text)).toBe(text);
  });

  it('keeps the platform limit and appends the truncation note', () => {
    const text = 'a'.repeat(10_000);
    const truncated = truncateWechatText(text);
    expect(Buffer.byteLength(truncated)).toBeLessThanOrEqual(3_500);
    expect(truncated.endsWith('完整内容请在 WorkLite 查看）')).toBe(true);
    expect(truncated.startsWith('a'.repeat(100))).toBe(true);
  });

  it('never splits a multi-byte character', () => {
    const truncated = truncateWechatText('微信渠道长回复'.repeat(1_000));
    expect(truncated).not.toContain('�');
    expect(Buffer.byteLength(truncated)).toBeLessThanOrEqual(3_500);
  });
});

describe('monitorFailureState', () => {
  it('stays silent below three consecutive failures', () => {
    expect(monitorFailureState(1, 0)).toBeNull();
    expect(monitorFailureState(2, WECHAT_CONNECT_FAILURE_ESCALATION_MS)).toBeNull();
  });

  it('keeps a recovering connecting state during short outages', () => {
    expect(monitorFailureState(3, 60_000)).toEqual({ status: 'connecting', reason: '微信连接暂时失败，正在自动重试。' });
  });

  it('escalates a sustained outage to an explicit error', () => {
    expect(monitorFailureState(4, WECHAT_CONNECT_FAILURE_ESCALATION_MS)).toEqual({ status: 'error', reason: '微信连接持续失败，请检查网络或重新扫码登录。' });
  });
});

// The two deliver() paths under test only ever select from externalChats, so a single
// configured row set is enough; a real empty-result chain covers any other `.from()` call.
function selectFrom(rows: unknown[]): unknown {
  return () => ({
    from: () => {
      const query = { where: () => query, orderBy: () => query, limit: () => query, then: (onFulfilled?: (value: unknown[]) => unknown) => Promise.resolve(rows).then(onFulfilled) };
      return query;
    },
  });
}

describe('WechatService#deliver typing indicator', () => {
  const baseSubmission = {
    id: 'sub-1', workspaceId: 'workspace_personal', chatId: 'wechat:user-a', executionId: null,
    message: 'hi', target: { kind: 'conversation' as const }, reference: null, outputMessageId: null,
    renderedCard: null, renderedTaskCards: null, deliveryFingerprint: null, settled: false,
    reportedAt: null, error: null, createdAt: new Date(), updatedAt: new Date(),
  };
  const chatRow = { id: 'wechat:user-a', externalId: 'user-a', contextToken: 'ctx-1' };

  it('signals typing instead of sending a placeholder text when nothing is ready to report', async () => {
    const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const endpoint = String(input).split('/ilink/bot/')[1];
      const body = init?.body ? JSON.parse(init.body) : {};
      calls.push({ endpoint, body });
      if (endpoint === 'getconfig') return { ok: true, status: 200, text: async () => '{"ret":0,"typing_ticket":"ticket-xyz"}' };
      return { ok: true, status: 200, text: async () => '{}' };
    };
    const db = { select: selectFrom([chatRow]), update: () => { throw new Error('deliver must not write when nothing is ready to report'); } };
    const service = new WechatService(db as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    (service as unknown as { fetchImpl: FetchLike; baseUrl: string; token: string }).fetchImpl = fetchImpl;
    (service as unknown as { baseUrl: string }).baseUrl = 'https://ilink.example';
    (service as unknown as { token: string }).token = 'tok';

    await (service as unknown as { deliver: (s: typeof baseSubmission) => Promise<void> }).deliver(baseSubmission);

    expect(calls.map((c) => c.endpoint)).toEqual(['getconfig', 'sendtyping']);
    expect(calls[1].body.status).toBe(1);
    expect(calls.some((c) => c.endpoint === 'sendmessage')).toBe(false);
  });

  it('cancels typing before sending the real reply text', async () => {
    const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const endpoint = String(input).split('/ilink/bot/')[1];
      const body = init?.body ? JSON.parse(init.body) : {};
      calls.push({ endpoint, body });
      if (endpoint === 'getconfig') return { ok: true, status: 200, text: async () => '{"ret":0,"typing_ticket":"ticket-xyz"}' };
      if (endpoint === 'sendmessage') return { ok: true, status: 200, text: async () => '{"ret":0,"message_id":"m1"}' };
      return { ok: true, status: 200, text: async () => '{}' };
    };
    const updates: Array<Record<string, unknown>> = [];
    const inserts: Array<Record<string, unknown>> = [];
    const db = {
      select: selectFrom([chatRow]),
      update: () => { const query = { set: (patch: Record<string, unknown>) => { updates.push(patch); return query; }, where: () => Promise.resolve(undefined) }; return query; },
      insert: () => { const query = { values: (v: Record<string, unknown>) => { inserts.push(v); return query; }, onConflictDoUpdate: () => Promise.resolve(undefined), onConflictDoNothing: () => Promise.resolve(undefined) }; return query; },
    };
    const service = new WechatService(db as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    (service as unknown as { fetchImpl: FetchLike }).fetchImpl = fetchImpl;
    (service as unknown as { baseUrl: string }).baseUrl = 'https://ilink.example';
    (service as unknown as { token: string }).token = 'tok';

    const submission = { ...baseSubmission, error: '任务失败示例' };
    await (service as unknown as { deliver: (s: typeof submission) => Promise<void> }).deliver(submission);

    const endpoints = calls.map((c) => c.endpoint);
    expect(endpoints.indexOf('sendtyping')).toBeGreaterThanOrEqual(0);
    expect(endpoints.indexOf('sendtyping')).toBeLessThan(endpoints.indexOf('sendmessage'));
    expect(calls[endpoints.indexOf('sendtyping')].body.status).toBe(2);
  });

  it('uses the exact text command when a new-conversation question is delivered', async () => {
    const sentTexts: string[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const endpoint = String(input).split('/ilink/bot/')[1];
      const body = init?.body ? JSON.parse(init.body) : {};
      if (endpoint === 'getconfig') return { ok: true, status: 200, text: async () => '{"ret":0,"typing_ticket":"ticket-xyz"}' };
      if (endpoint === 'sendmessage') {
        sentTexts.push(body.msg.item_list[0].text_item.text);
        return { ok: true, status: 200, text: async () => '{"ret":0,"message_id":"m-new-conversation"}' };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    };
    const update = () => {
      const query = { set: () => query, where: () => Promise.resolve(undefined) };
      return query;
    };
    const insert = () => {
      const query = { values: () => query, onConflictDoUpdate: () => Promise.resolve(undefined) };
      return query;
    };
    const db = { select: selectFrom([chatRow]), update, insert };
    const executions = {
      get: async () => ({ status: 'waiting_for_input', error: null, messages: [], pendingQuestion: { id: 'q-new', question: 'Click the button to begin a new conversation.', options: [], action: 'new_conversation' } }),
    };
    const service = new WechatService(db as never, {} as never, {} as never, executions as never, {} as never, {} as never, {} as never);
    (service as unknown as { fetchImpl: FetchLike; baseUrl: string; token: string }).fetchImpl = fetchImpl;
    (service as unknown as { baseUrl: string; token: string }).baseUrl = 'https://ilink.example';
    (service as unknown as { token: string }).token = 'tok';
    const submission = {
      ...baseSubmission,
      reference: { kind: 'conversation' as const, executionId: 'aex_1', afterMessageId: null, afterSequence: 0 },
    };

    await (service as unknown as { deliver: (s: typeof submission) => Promise<void> }).deliver(submission);

    expect(sentTexts).toEqual(['请回复「新对话」开始新对话。']);
  });
});

describe('WechatService "新对话" command', () => {
  const WORKSPACE_ID = 'workspace_personal';
  const ALLOWED_USER = 'user-a';
  const CHAT_ID = `wechat:${ALLOWED_USER}`;
  let db: Database;

  const rawMessage = (messageId: string, text: string) => ({
    message_type: 1,
    message_id: messageId,
    from_user_id: ALLOWED_USER,
    item_list: [{ type: 1, text_item: { text } }],
  });

  function service(options: { execution?: Partial<AgentExecutionView> | null; dispatch?: () => Promise<unknown> } = {}) {
    const executions = {
      get: async () => (options.execution === null || options.execution === undefined
        ? undefined
        : { id: 'aex_1', status: 'completed', pendingQuestion: null, ...options.execution }) as AgentExecutionView,
    };
    const dispatched: unknown[] = [];
    const dispatches = {
      dispatch: async (_request: unknown, input: unknown) => {
        dispatched.push(input);
        return options.dispatch ? await options.dispatch() : { submissionId: (input as { submissionId: string }).submissionId, reference: { kind: 'conversation', executionId: 'aex_new', afterMessageId: null, afterSequence: 0 } };
      },
    };
    const instance = new WechatService(db as never, {} as never, dispatches as never, executions as never, {} as never, {} as never, {} as never);
    (instance as unknown as { allowedUserId: string }).allowedUserId = ALLOWED_USER;
    return { instance, dispatched };
  }

  beforeEach(async () => {
    db = createDb(':memory:');
    await initializeDatabase(db); // Already seeds workspace_personal; inserting it again violates the slug unique index.
  });

  afterEach(() => {
    db.$client.close();
  });

  it('unbinds a completed conversation so the next message starts fresh', async () => {
    db.insert(externalChats).values({ id: CHAT_ID, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: ALLOWED_USER, userId: ALLOWED_USER, executionId: 'aex_1' }).run();
    const { instance } = service({ execution: { status: 'completed', pendingQuestion: null } });

    await (instance as unknown as { receiveMessage: (raw: unknown) => Promise<void> }).receiveMessage(rawMessage('msg-1', '新对话'));

    const rows = db.select().from(externalChats).all() as Array<{ executionId: string | null }>;
    expect(rows[0].executionId).toBeNull();
    // The command's own text still becomes the queued opening message of the new conversation,
    // which the (mocked) dispatch will turn into a brand-new executionId once `work()` runs.
    const submissions = db.select().from(chatSubmissions).all() as Array<{ message: string; executionId: string | null }>;
    expect(submissions).toHaveLength(1);
    expect(submissions[0].message).toBe('新对话');
    expect(submissions[0].executionId).toBeNull();
  });

  it('unbinds a failed conversation (the original escape case still works)', async () => {
    db.insert(externalChats).values({ id: CHAT_ID, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: ALLOWED_USER, userId: ALLOWED_USER, executionId: 'aex_1' }).run();
    const { instance } = service({ execution: { status: 'failed', pendingQuestion: null } });

    await (instance as unknown as { receiveMessage: (raw: unknown) => Promise<void> }).receiveMessage(rawMessage('msg-2', '新对话'));

    const rows = db.select().from(externalChats).all() as Array<{ executionId: string | null }>;
    expect(rows[0].executionId).toBeNull();
  });

  it('unbinds a running conversation without disturbing its own in-flight turn', async () => {
    db.insert(externalChats).values({ id: CHAT_ID, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: ALLOWED_USER, userId: ALLOWED_USER, executionId: 'aex_1' }).run();
    const { instance } = service({ execution: { status: 'running', pendingQuestion: null } });

    await (instance as unknown as { receiveMessage: (raw: unknown) => Promise<void> }).receiveMessage(rawMessage('msg-3', '新对话'));

    const rows = db.select().from(externalChats).all() as Array<{ executionId: string | null }>;
    expect(rows[0].executionId).toBeNull();
  });

  it('treats a plain message as an ordinary submission and keeps the binding intact', async () => {
    db.insert(externalChats).values({ id: CHAT_ID, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: ALLOWED_USER, userId: ALLOWED_USER, executionId: 'aex_1' }).run();
    const { instance, dispatched } = service({ execution: { status: 'completed', pendingQuestion: null } });

    await (instance as unknown as { receiveMessage: (raw: unknown) => Promise<void> }).receiveMessage(rawMessage('msg-4', '继续聊聊天气'));

    const rows = db.select().from(externalChats).all() as Array<{ executionId: string | null }>;
    expect(rows[0].executionId).toBe('aex_1');
    const submissions = db.select().from(chatSubmissions).all() as Array<{ message: string; executionId: string | null }>;
    expect(submissions).toHaveLength(1);
    expect(submissions[0].message).toBe('继续聊聊天气');
    expect(submissions[0].executionId).toBe('aex_1');
    expect(dispatched).toHaveLength(0); // receiveMessage only persists; work() dispatches separately.
  });

  it('takes "新对话" as the literal answer to a pending ordinary question instead of unbinding', async () => {
    db.insert(externalChats).values({ id: CHAT_ID, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: ALLOWED_USER, userId: ALLOWED_USER, executionId: 'aex_1' }).run();
    const { instance } = service({ execution: { status: 'waiting_for_input', pendingQuestion: { id: 'q_1', question: '继续吗？', options: [], createdAt: new Date().toISOString() } } });

    await (instance as unknown as { receiveMessage: (raw: unknown) => Promise<void> }).receiveMessage(rawMessage('msg-5', '新对话'));

    const rows = db.select().from(externalChats).all() as Array<{ executionId: string | null }>;
    expect(rows[0].executionId).toBe('aex_1'); // Still bound: the text became the question's answer, not an unbind.
    const events = db.select().from(wechatEvents).all() as Array<{ payload: { action?: { kind: string; questionId: string } } }>;
    expect(events[0].payload.action).toEqual(expect.objectContaining({ kind: 'agent_answer', questionId: 'q_1' }));
  });

  it('starts a new conversation only when the pending new-conversation question gets the exact command', async () => {
    db.insert(externalChats).values({ id: CHAT_ID, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: ALLOWED_USER, userId: ALLOWED_USER, executionId: 'aex_1' }).run();
    const { instance } = service({ execution: { status: 'waiting_for_input', pendingQuestion: { id: 'q_new', question: 'Click the button to begin.', options: [], action: 'new_conversation', createdAt: new Date().toISOString() } } });

    await (instance as unknown as { receiveMessage: (raw: unknown) => Promise<void> }).receiveMessage(rawMessage('msg-new-exact', '新对话'));

    const events = db.select().from(wechatEvents).all() as Array<{ payload: { action?: { newConversation?: boolean }; form?: { answer: string } } }>;
    expect(events[0].payload.action?.newConversation).toBe(true);
    expect(events[0].payload.form?.answer).toBe('新对话');
  });

  it('does not start a new conversation for other text answering that pending question', async () => {
    db.insert(externalChats).values({ id: CHAT_ID, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: ALLOWED_USER, userId: ALLOWED_USER, executionId: 'aex_1' }).run();
    const { instance } = service({ execution: { status: 'waiting_for_input', pendingQuestion: { id: 'q_new', question: 'Click the button to begin.', options: [], action: 'new_conversation', createdAt: new Date().toISOString() } } });

    await (instance as unknown as { receiveMessage: (raw: unknown) => Promise<void> }).receiveMessage(rawMessage('msg-new-other', '继续当前对话'));

    const rows = db.select().from(externalChats).all() as Array<{ executionId: string | null }>;
    expect(rows[0].executionId).toBe('aex_1');
    const events = db.select().from(wechatEvents).all() as Array<{ payload: { action?: { newConversation?: boolean }; form?: { answer: string } } }>;
    expect(events[0].payload.action).not.toHaveProperty('newConversation');
    expect(events[0].payload.form?.answer).toBe('继续当前对话');
  });

  it('is idempotent on a redelivered message id (no double-unbind, no duplicate submission)', async () => {
    db.insert(externalChats).values({ id: CHAT_ID, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: ALLOWED_USER, userId: ALLOWED_USER, executionId: 'aex_1' }).run();
    const { instance } = service({ execution: { status: 'completed', pendingQuestion: null } });
    const receiveMessage = (instance as unknown as { receiveMessage: (raw: unknown) => Promise<void> }).receiveMessage.bind(instance);

    await receiveMessage(rawMessage('msg-6', '新对话'));
    await receiveMessage(rawMessage('msg-6', '新对话')); // Same platform message id redelivered.

    const rows = db.select().from(externalChats).all() as Array<{ executionId: string | null }>;
    expect(rows[0].executionId).toBeNull();
    // onConflictDoNothing on the receipt means the redelivery never re-enters the unbind or
    // submission branch a second time: still exactly one wechatEvent and one submission.
    const events = db.select().from(wechatEvents).all();
    expect(events).toHaveLength(1);
    const submissions = db.select().from(chatSubmissions).all();
    expect(submissions).toHaveLength(1);
  });
});

describe('WechatService monitor under an upgrade freeze', () => {
  let directory = '';

  afterEach(() => {
    delete process.env.WORKLITE_RUNTIME_STATE_DIR;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  it('waits out the frozen phase and resumes polling instead of exiting', async () => {
    directory = mkdtempSync(join(tmpdir(), 'worklite-wechat-test-'));
    mkdirSync(join(directory, 'upgrades'));
    writeFileSync(join(directory, 'active.json'), JSON.stringify({ jobId: 'upgrade_freeze' }));
    const jobPath = join(directory, 'upgrades', 'upgrade_freeze.json');
    writeFileSync(jobPath, JSON.stringify({ phase: 'switching' }));
    process.env.WORKLITE_RUNTIME_STATE_DIR = directory;

    let fetches = 0;
    // After the first successful poll, hang like a real long-poll until the monitor aborts,
    // so the test does not spin a tight loop against an instant mock.
    const fetchImpl: FetchLike = async (_input, init) => {
      fetches += 1;
      if (fetches > 1) await new Promise((resolve) => { init?.signal?.addEventListener('abort', resolve, { once: true }); });
      return { ok: true, status: 200, text: async () => '{"ret":0,"errcode":0,"msgs":[],"get_updates_buf":"buf-1"}' };
    };
    const updates: Array<Record<string, unknown>> = [];
    const plugins = {
      wechatSecret: async () => ({ wechatEnabled: true, botToken: 'tok', wechatAllowedUserId: 'user-a', wechatBaseUrl: '', wechatSyncBuf: '' }),
      updateWechat: async (patch: Record<string, unknown>) => { updates.push(patch); },
    };
    const db = { select: emptyQuery, update: emptyQuery, insert: emptyQuery };
    const service = new WechatService(db as never, plugins as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    (service as unknown as { fetchImpl: FetchLike }).fetchImpl = fetchImpl;

    try {
      await service.connect();
      await delay(300);
      // The frozen phase must not start polling, and must not kill the monitor either.
      expect(fetches).toBe(0);
      writeFileSync(jobPath, JSON.stringify({ phase: 'succeeded' }));
      await waitFor(() => fetches > 0);
      await waitFor(() => updates.some((patch) => patch.wechatStatus === 'connected'));
    } finally {
      service.onModuleDestroy();
    }
  });
});
