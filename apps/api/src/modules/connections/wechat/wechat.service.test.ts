import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { createDecipheriv } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, initializeDatabase, agentExecutions, agentPendingActions, agents, artifacts, externalChats, chatSubmissions, wechatEvents, type Database } from '@worklite/db';
import { eq } from 'drizzle-orm';
import type { AgentExecutionView } from '@worklite/contracts';
import { isWechatNewConversationCommand, monitorFailureState, WECHAT_CONNECT_FAILURE_ESCALATION_MS, WECHAT_NEW_CONVERSATION_REPLY, WechatService } from './wechat.service';
import type { FetchLike } from './ilink';
import type { ArtifactStorageService } from '../../artifacts/artifact-storage.service';
import { readArtifactImageContent } from '../../artifacts/artifact-image-content';
import { formatWechatReply, WECHAT_TEXT_BYTES } from './wechat-reply-format';

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

describe('isWechatNewConversationCommand', () => {
  it('matches only the exact command spellings after trimming', () => {
    expect(isWechatNewConversationCommand('新对话')).toBe(true);
    expect(isWechatNewConversationCommand(' 新对话 ')).toBe(true);
    expect(isWechatNewConversationCommand('/新对话')).toBe(true);
    expect(isWechatNewConversationCommand('／新对话')).toBe(true);
    expect(isWechatNewConversationCommand('请开始新对话')).toBe(false);
    expect(isWechatNewConversationCommand('新 对话')).toBe(false);
    expect(isWechatNewConversationCommand('')).toBe(false);
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

describe('WeChat Agent dispatch notice delivery', () => {
  let db: Database;
  let instance: WechatService;
  let attempts: Array<{ msg: { client_id: string; context_token: string; item_list: Array<{ type: number; text_item: { text: string } }> } }>;
  let failureCode: number;
  let networkFailure: boolean;
  let updates: unknown[];

  const restart = () => {
    const executions = { get: async () => { throw new Error('Launch notices must not read the live Chat turn'); } };
    const configuration = { updateWechat: async (update: unknown) => { updates.push(update); } };
    const service = new WechatService(db, configuration as never, {} as never, executions as never, {} as never, {} as never, {} as never);
    const fetchImpl: FetchLike = async (input, init) => {
      if (String(input).endsWith('/sendmessage')) {
        attempts.push(JSON.parse(init!.body as string));
        if (networkFailure) throw new Error('Temporary network failure');
        if (failureCode) return { ok: true, status: 200, text: async () => JSON.stringify({ ret: failureCode, errcode: failureCode }) };
        return { ok: true, status: 200, text: async () => '{"ret":0,"message_id":"launch-message"}' };
      }
      return { ok: true, status: 200, text: async () => '{"ret":0}' };
    };
    Object.assign(service, { fetchImpl, baseUrl: 'https://ilink.example', token: 'tok', allowedUserId: 'user', stopped: false });
    return service;
  };
  const work = () => (instance as unknown as { work(): Promise<void> }).work();

  beforeEach(async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    attempts = []; updates = []; failureCode = 0; networkFailure = false;
    db.insert(agentExecutions).values({ id: 'chat-launch', workspaceId: 'workspace_personal', agentId: 'agt_system_helper_chat', status: 'running' }).run();
    db.insert(externalChats).values({ id: 'wechat:launch', workspaceId: 'workspace_personal', channel: 'wechat', externalId: 'user', userId: 'user', executionId: 'chat-launch', contextToken: 'ctx-launch' }).run();
    db.insert(chatSubmissions).values({ id: 'dispatch_call', workspaceId: 'workspace_personal', chatId: 'wechat:launch', executionId: 'chat-launch', message: '', target: { kind: 'conversation' }, reference: { kind: 'conversation', executionId: 'chat-launch', afterMessageId: null, afterSequence: 0, completionStatus: 'completed', dispatchNotice: '已派 @codex：修复问题，正在执行' } }).run();
    instance = restart();
  });
  afterEach(() => db.$client.close());

  it('delivers a text-only closed window while Chat runs and stays settled after restart', async () => {
    await work();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].msg).toMatchObject({ context_token: 'ctx-launch', item_list: [{ type: 1, text_item: { text: '已派 @codex：修复问题，正在执行' } }] });
    expect(db.select().from(chatSubmissions).get()!.settled).toBe(true);
    instance = restart();
    await work();
    expect(attempts).toHaveLength(1);
  });

  it.each(['network', 'stale-login'] as const)('retries %s failures after restart with the same client id', async (failure) => {
    networkFailure = failure === 'network'; failureCode = failure === 'stale-login' ? -14 : 0;
    await work();
    expect(db.select().from(chatSubmissions).get()!.settled).toBe(false);
    if (failure === 'stale-login') expect(updates).toContainEqual({ wechatStatus: 'error', wechatLastError: '微信登录已过期，请重新扫码登录。' });
    expect(db.select().from(wechatEvents).all().some((event) => event.status === 'failed')).toBe(true);
    networkFailure = false; failureCode = 0;
    instance = restart();
    await work();
    expect(attempts).toHaveLength(2);
    expect(attempts[0].msg.client_id).toBe(attempts[1].msg.client_id);
    expect(db.select().from(chatSubmissions).get()!.settled).toBe(true);
  });

  it('uses the persisted part receipt after interruption before the window settled', async () => {
    await work();
    db.update(chatSubmissions).set({ settled: false, deliveryFingerprint: null }).run();
    instance = restart();
    await work();
    expect(attempts).toHaveLength(1);
    expect(db.select().from(chatSubmissions).get()!.settled).toBe(true);
  });

  it('does not interpret a notice as an attachment or replay later assistant messages', async () => {
    const row = db.select().from(chatSubmissions).get()!;
    if (row.reference?.kind !== 'conversation') throw new Error('Missing notice');
    const dispatchNotice = '已派 @codex：读取 [报告](/api/artifacts/art_report/content?download=true)，正在执行';
    db.update(chatSubmissions).set({ reference: { ...row.reference, dispatchNotice } }).run();
    await work();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].msg.item_list).toEqual([{ type: 1, text_item: { text: dispatchNotice } }]);
  });

  it('settles an empty notice quietly without sending broken content', async () => {
    const row = db.select().from(chatSubmissions).get()!;
    if (row.reference?.kind !== 'conversation') throw new Error('Missing notice');
    db.update(chatSubmissions).set({ reference: { ...row.reference, dispatchNotice: '' } }).run();
    await work();
    expect(attempts).toEqual([]);
    expect(db.select().from(chatSubmissions).get()!.settled).toBe(true);
  });
});

// Receipt lookups must stay empty; only externalChats returns the configured conversation.
function selectFrom(rows: unknown[]): unknown {
  return () => ({
    from: (table: unknown) => {
      const query = { where: () => query, orderBy: () => query, limit: () => query, then: (onFulfilled?: (value: unknown[]) => unknown) => Promise.resolve(table === externalChats ? rows : []).then(onFulfilled) };
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
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
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
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
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
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
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

  it('settles an answered turn without sending a filler message', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      calls.push(String(input).split('/ilink/bot/')[1]);
      return { ok: true, status: 200, text: async () => '{"ret":0}' };
    };
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      select: selectFrom([chatRow]),
      update: () => { const query = { set: (patch: Record<string, unknown>) => { updates.push(patch); return query; }, where: () => Promise.resolve(undefined) }; return query; },
    };
    // The turn asked a question, then the user answered, so dispatch froze it as completed with
    // no assistant reply inside its window.
    const executions = {
      get: async () => ({ status: 'running', error: null, pendingQuestion: null, messages: [
        { id: 'm-question-turn', role: 'user', content: '帮我写一篇' },
        { id: 'm-answer', role: 'user', content: '好的' },
      ] }),
    };
    const service = new WechatService(db as never, {} as never, {} as never, executions as never, {} as never, {} as never, {} as never);
    (service as unknown as { fetchImpl: FetchLike }).fetchImpl = fetchImpl;
    (service as unknown as { baseUrl: string }).baseUrl = 'https://ilink.example';
    (service as unknown as { token: string }).token = 'tok';
    const submission = {
      ...baseSubmission,
      reference: { kind: 'conversation' as const, executionId: 'aex_1', afterMessageId: null, afterSequence: 0, untilMessageId: 'm-question-turn', completionStatus: 'completed', completionError: null },
    };

    await (service as unknown as { deliver: (s: typeof submission) => Promise<void> }).deliver(submission);

    expect(calls).not.toContain('sendmessage');
    expect(updates).toEqual([{ settled: true }]);
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

  function service(options: { execution?: Partial<AgentExecutionView> | null; dispatch?: () => Promise<unknown>; transport?: boolean } = {}) {
    const getCalls: string[] = [];
    const executions = {
      get: async (_request: unknown, _workspace: string, _agentId: string, id: string) => {
        getCalls.push(id);
        return (options.execution === null || options.execution === undefined
          ? undefined
          : { id: 'aex_1', status: 'completed', pendingQuestion: null, ...options.execution }) as AgentExecutionView;
      },
    };
    const dispatched: unknown[] = [];
    const dispatches = {
      dispatch: async (_request: unknown, input: unknown) => {
        dispatched.push(input);
        return options.dispatch ? await options.dispatch() : { submissionId: (input as { submissionId: string }).submissionId, reference: { kind: 'conversation', executionId: 'aex_new', afterMessageId: null, afterSequence: 0 } };
      },
    };
    const sends: string[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const endpoint = String(input).split('/ilink/bot/')[1];
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { msg?: { item_list?: Array<{ text_item?: { text?: string } }> } } : {};
      if (endpoint === 'sendmessage') {
        sends.push(body.msg?.item_list?.[0]?.text_item?.text ?? '');
        return { ok: true, status: 200, text: async () => '{"ret":0,"message_id":"reply-1"}' };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    };
    const instance = new WechatService(db as never, {} as never, dispatches as never, executions as never, {} as never, {} as never, {} as never);
    (instance as unknown as { allowedUserId: string }).allowedUserId = ALLOWED_USER;
    if (options.transport) {
      (instance as unknown as { fetchImpl: FetchLike }).fetchImpl = fetchImpl;
      (instance as unknown as { baseUrl: string }).baseUrl = 'https://ilink.example';
      (instance as unknown as { token: string }).token = 'tok';
    }
    return { instance, dispatched, getCalls, sends };
  }

  const receive = (instance: WechatService, raw: unknown) => (instance as unknown as { receiveMessage: (raw: unknown) => Promise<void> }).receiveMessage(raw);

  beforeEach(async () => {
    db = createDb(':memory:');
    await initializeDatabase(db); // Already seeds workspace_personal; inserting it again violates the slug unique index.
  });

  afterEach(() => {
    db.$client.close();
  });

  it('starts a new conversation in the adapter without a submission, execution or Agent dispatch', async () => {
    db.insert(externalChats).values({ id: CHAT_ID, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: ALLOWED_USER, userId: ALLOWED_USER, executionId: 'aex_1' }).run();
    const { instance, dispatched, getCalls, sends } = service({ execution: { status: 'completed', pendingQuestion: null }, transport: true });

    await receive(instance, rawMessage('msg-1', '新对话'));

    const rows = db.select().from(externalChats).all() as Array<{ executionId: string | null }>;
    expect(rows[0].executionId).toBeNull();
    // The command is fully adapter-owned: no submission is written and the Chat runtime is never
    // asked to look up, create or answer an execution.
    expect(db.select().from(chatSubmissions).all()).toHaveLength(0);
    expect(db.select().from(agentExecutions).all()).toHaveLength(0);
    expect(getCalls).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
    expect(sends).toEqual([WECHAT_NEW_CONVERSATION_REPLY]);
    const events = db.select().from(wechatEvents).all() as Array<{ id: string; status: string; payload: { command?: string; text?: string } }>;
    const receipt = events.find((event) => event.id === 'message:msg-1');
    expect(receipt?.status).toBe('done');
    expect(receipt?.payload).toMatchObject({ command: 'new_conversation', text: '新对话' });
  });

  it('accepts the trimmed command and its explicit slash spelling', async () => {
    db.insert(externalChats).values({ id: CHAT_ID, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: ALLOWED_USER, userId: ALLOWED_USER, executionId: 'aex_1' }).run();
    const { instance, sends } = service({ transport: true });

    await receive(instance, rawMessage('msg-trim', '  新对话  '));
    await receive(instance, rawMessage('msg-slash', '/新对话'));

    const rows = db.select().from(externalChats).all() as Array<{ executionId: string | null }>;
    expect(rows[0].executionId).toBeNull();
    expect(db.select().from(chatSubmissions).all()).toHaveLength(0);
    expect(sends).toEqual([WECHAT_NEW_CONVERSATION_REPLY, WECHAT_NEW_CONVERSATION_REPLY]);
  });

  it('unbinds a failed conversation (the original escape case still works)', async () => {
    db.insert(externalChats).values({ id: CHAT_ID, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: ALLOWED_USER, userId: ALLOWED_USER, executionId: 'aex_1' }).run();
    const { instance } = service({ execution: { status: 'failed', pendingQuestion: null } });

    await receive(instance, rawMessage('msg-2', '新对话'));

    const rows = db.select().from(externalChats).all() as Array<{ executionId: string | null }>;
    expect(rows[0].executionId).toBeNull();
  });

  it('unbinds a running conversation without disturbing its own in-flight turn', async () => {
    db.insert(externalChats).values({ id: CHAT_ID, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: ALLOWED_USER, userId: ALLOWED_USER, executionId: 'aex_1' }).run();
    const { instance } = service({ execution: { status: 'running', pendingQuestion: null } });

    await receive(instance, rawMessage('msg-3', '新对话'));

    const rows = db.select().from(externalChats).all() as Array<{ executionId: string | null }>;
    expect(rows[0].executionId).toBeNull();
  });

  it('treats a plain message as an ordinary submission and keeps the binding intact', async () => {
    db.insert(externalChats).values({ id: CHAT_ID, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: ALLOWED_USER, userId: ALLOWED_USER, executionId: 'aex_1' }).run();
    const { instance, dispatched } = service({ execution: { status: 'completed', pendingQuestion: null } });

    await receive(instance, rawMessage('msg-4', '继续聊聊天气'));

    const rows = db.select().from(externalChats).all() as Array<{ executionId: string | null }>;
    expect(rows[0].executionId).toBe('aex_1');
    const submissions = db.select().from(chatSubmissions).all() as Array<{ message: string; executionId: string | null }>;
    expect(submissions).toHaveLength(1);
    expect(submissions[0].message).toBe('继续聊聊天气');
    expect(submissions[0].executionId).toBe('aex_1');
    expect(dispatched).toHaveLength(0); // receiveMessage only persists; work() dispatches separately.
  });

  it('takes the command over a pending ordinary question without sending it as an answer', async () => {
    db.insert(externalChats).values({ id: CHAT_ID, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: ALLOWED_USER, userId: ALLOWED_USER, executionId: 'aex_1' }).run();
    const { instance, dispatched, getCalls, sends } = service({ execution: { status: 'waiting_for_input', pendingQuestion: { id: 'q_1', question: '继续吗？', options: [], createdAt: new Date().toISOString() } }, transport: true });

    await receive(instance, rawMessage('msg-5', '新对话'));

    const rows = db.select().from(externalChats).all() as Array<{ executionId: string | null }>;
    expect(rows[0].executionId).toBeNull();
    const events = db.select().from(wechatEvents).all() as Array<{ id: string; payload: { action?: unknown } }>;
    expect(events.find((event) => event.id === 'message:msg-5')?.payload).not.toHaveProperty('action');
    expect(db.select().from(chatSubmissions).all()).toHaveLength(0);
    expect(getCalls).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
    expect(sends).toEqual([WECHAT_NEW_CONVERSATION_REPLY]);
  });

  it('intercepts the command while a new-conversation question is pending', async () => {
    db.insert(externalChats).values({ id: CHAT_ID, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: ALLOWED_USER, userId: ALLOWED_USER, executionId: 'aex_1' }).run();
    const { instance, dispatched, getCalls } = service({ execution: { status: 'waiting_for_input', pendingQuestion: { id: 'q_new', question: 'Click the button to begin.', options: [], action: 'new_conversation', createdAt: new Date().toISOString() } } });

    await receive(instance, rawMessage('msg-new-exact', '新对话'));

    const rows = db.select().from(externalChats).all() as Array<{ executionId: string | null }>;
    expect(rows[0].executionId).toBeNull();
    const events = db.select().from(wechatEvents).all() as Array<{ id: string; payload: { action?: unknown } }>;
    expect(events.find((event) => event.id === 'message:msg-new-exact')?.payload).not.toHaveProperty('action');
    expect(db.select().from(chatSubmissions).all()).toHaveLength(0);
    expect(getCalls).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
  });

  it('does not start a new conversation for other text answering that pending question', async () => {
    db.insert(externalChats).values({ id: CHAT_ID, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: ALLOWED_USER, userId: ALLOWED_USER, executionId: 'aex_1' }).run();
    const { instance } = service({ execution: { status: 'waiting_for_input', pendingQuestion: { id: 'q_new', question: 'Click the button to begin.', options: [], action: 'new_conversation', createdAt: new Date().toISOString() } } });

    await receive(instance, rawMessage('msg-new-other', '继续当前对话'));

    const rows = db.select().from(externalChats).all() as Array<{ executionId: string | null }>;
    expect(rows[0].executionId).toBe('aex_1');
    const events = db.select().from(wechatEvents).all() as Array<{ payload: { action?: { newConversation?: boolean }; form?: { answer: string } } }>;
    expect(events[0].payload.action).not.toHaveProperty('newConversation');
    expect(events[0].payload.form?.answer).toBe('继续当前对话');
  });

  it('handles a redelivered message id once and never unbinds a newer conversation', async () => {
    db.insert(externalChats).values({ id: CHAT_ID, workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: ALLOWED_USER, userId: ALLOWED_USER, executionId: 'aex_1' }).run();
    const { instance, sends } = service({ execution: { status: 'completed', pendingQuestion: null }, transport: true });

    await receive(instance, rawMessage('msg-6', '新对话'));
    // The user already sent a real message, which bound a fresh execution, before the old
    // command was redelivered by the platform.
    db.update(externalChats).set({ executionId: 'aex_after' }).where(eq(externalChats.id, CHAT_ID)).run();
    await receive(instance, rawMessage('msg-6', '新对话'));

    const rows = db.select().from(externalChats).all() as Array<{ executionId: string | null }>;
    expect(rows[0].executionId).toBe('aex_after');
    // The receipt guard keeps the redelivery from re-unbinding or sending a second confirmation.
    const receipts = db.select().from(wechatEvents).all().filter((event) => event.id === 'message:msg-6');
    expect(receipts).toHaveLength(1);
    expect(sends).toEqual([WECHAT_NEW_CONVERSATION_REPLY]);
    expect(db.select().from(chatSubmissions).all()).toHaveLength(0);
  });
});

describe('WechatService native reply images', () => {
  let db: Database;
  let directory: string;
  let instance: WechatService;
  let storage: ArtifactStorageService;
  let submission: typeof chatSubmissions.$inferSelect;
  let reply: string;
  let rejectText: string;
  let rejectNextImage: boolean;
  let rejectFileCode: number;
  let rejectFallback: boolean;
  let mediaTypes: number[];
  let fileClientIds: string[];
  let uploads: Buffer[];
  let messages: Array<{ type: number; text?: string; clientId: string; contextToken: string; fileName?: string }>;
  const image = createCanvas(2, 2).toBuffer('image/png');
  const workspaceId = 'workspace_personal';

  beforeEach(async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    directory = mkdtempSync(join(tmpdir(), 'worklite-wechat-images-'));
    const attachmentPath = join(directory, 'attachment');
    writeFileSync(attachmentPath, image);
    db.insert(externalChats).values({ id: 'wechat:images', workspaceId, channel: 'wechat', externalId: 'user-a', userId: 'user-a', contextToken: 'ctx-images' }).run();
    db.insert(artifacts).values([
      { id: 'art_good', workspaceId, name: '图片', format: 'image', objectKey: 'artifacts/art_good.png', mimeType: 'image/png', sizeBytes: image.length },
      { id: 'art_invalid', workspaceId, name: '损坏图片', format: 'image', objectKey: 'artifacts/art_invalid.png', mimeType: 'image/png' },
      { id: 'art_text', workspaceId, name: '文本', format: 'text' },
      { id: 'art_report', workspaceId, name: '调研报告', format: 'markdown', content: '# 实际产物\n正文' },
      { id: 'art_binary', workspaceId, name: '资料 中文.zip', format: 'unsupported', objectKey: 'artifacts/art_binary.bin', mimeType: 'application/octet-stream' },
      { id: 'art_large', workspaceId, name: '大文件.zip', format: 'unsupported', objectKey: 'artifacts/art_large.bin', sizeBytes: 20 * 1024 * 1024 + 1 },
    ]).run();
    submission = db.insert(chatSubmissions).values({ id: 'sub-images', workspaceId, chatId: 'wechat:images', message: '发图', target: { kind: 'conversation' }, reference: { kind: 'conversation', executionId: 'aex_images', afterMessageId: null, afterSequence: 0, completionStatus: 'completed', untilMessageId: null, completionError: null } }).returning().get();
    storage = { read: async (key: string) => {
      if (key === 'artifacts/art_good.png') return image;
      if (key === 'artifacts/art_binary.bin') return Buffer.from('opaque-zip-bytes');
      if (key === 'artifacts/art_invalid.png') return Buffer.from('not an image');
      throw new NotFoundException();
    } } as ArtifactStorageService;
    const attachments = { open: (scope: string, id: string) => {
      if (scope !== workspaceId || id !== 'att_good') throw new NotFoundException();
      return { path: attachmentPath, attachment: { mimeType: 'image/png', fileName: '附件.png' } };
    } };
    const executions = { get: async () => ({ status: 'completed', messages: [{ id: 'reply-images', role: 'assistant', content: reply }] }) };
    instance = new WechatService(db, {} as never, {} as never, executions as never, {} as never, attachments as never, storage);
    reply = ''; rejectText = ''; rejectNextImage = false; rejectFileCode = 0; rejectFallback = false; mediaTypes = []; fileClientIds = []; uploads = []; messages = [];
    let aeskey = '';
    const fetchImpl: FetchLike = async (input, init) => {
      if (String(input) === 'https://cdn.example/image') {
        const decipher = createDecipheriv('aes-128-ecb', Buffer.from(aeskey, 'hex'), null);
        uploads.push(Buffer.concat([decipher.update(init!.body as Buffer), decipher.final()]));
        return { ok: true, status: 200, text: async () => '', headers: { get: (name: string) => name === 'x-encrypted-param' ? 'download-param' : null } };
      }
      const endpoint = String(input).split('/ilink/bot/')[1];
      const body = JSON.parse(init!.body as string);
      if (endpoint === 'getuploadurl') {
        aeskey = body.aeskey;
        mediaTypes.push(body.media_type);
        return { ok: true, status: 200, text: async () => '{"ret":0,"upload_full_url":"https://cdn.example/image"}' };
      }
      if (endpoint === 'sendmessage') {
        const item = body.msg.item_list[0];
        if (item.type === 4) fileClientIds.push(body.msg.client_id);
        if (item.type === 4 && rejectFileCode) {
          const code = rejectFileCode; rejectFileCode = 0;
          return { ok: true, status: 200, text: async () => JSON.stringify({ ret: code, errcode: code, errmsg: 'file rejected' }) };
        }
        if (rejectFallback && item.text_item?.text.startsWith('[文件发送失败')) throw new Error('Fallback failed');
        if (item.type === 2 && rejectNextImage) {
          rejectNextImage = false;
          return { ok: true, status: 200, text: async () => '{"ret":-1,"errmsg":"image rejected"}' };
        }
        if (item.text_item?.text === rejectText) throw new Error('Temporary text send failure');
        messages.push({ type: item.type, text: item.text_item?.text, clientId: body.msg.client_id, contextToken: body.msg.context_token, ...(item.file_item ? { fileName: item.file_item.file_name } : {}) });
        return { ok: true, status: 200, text: async () => JSON.stringify({ ret: 0, message_id: `message-${messages.length}` }) };
      }
      return { ok: true, status: 200, text: async () => '{"ret":0}' };
    };
    Object.assign(instance, { fetchImpl, baseUrl: 'https://ilink.example', token: 'tok' });
  });

  afterEach(() => {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const deliver = () => (instance as unknown as { deliver: (value: typeof submission) => Promise<void> }).deliver(submission);

  it('delivers an authorization QR as a native image and preserves its browser entry in WeChat', async () => {
    const scanUrl = 'http://192.168.1.10:23393/scan/' + 'a'.repeat(64);
    reply = `![公众号授权二维码](/api/chat/attachments/att_good)\n\n公众号授权页面：${scanUrl}`;
    await deliver();
    expect(messages.map((message) => message.type)).toEqual([2, 1]);
    expect(uploads).toEqual([image]);
    expect(messages[1].text).toContain(scanUrl);
    expect(messages.every((message) => message.contextToken === 'ctx-images')).toBe(true);
    await deliver();
    expect(uploads).toHaveLength(1);
  });

  it.each(['live', 'expired', 'replaced', 'completed'] as const)('delivers a queued %s authorization independently of the running Agent', async (state) => {
    const expiresAt = new Date(Date.now() + (state === 'expired' ? -1 : 120_000));
    db.insert(agents).values({ id: 'qr-agent', workspaceId, name: 'Publisher', responsibility: 'Test', systemPrompt: '', model: '' }).run();
    db.insert(agentExecutions).values({ id: 'qr-execution', workspaceId, agentId: 'qr-agent', status: 'running' }).run();
    db.insert(agentPendingActions).values({ id: 'qr-action', workspaceId, runId: 'qr-execution', nodeRunId: 'qr-call', type: 'wechat_login', title: 'Login', description: 'Scan', status: state === 'completed' ? 'completed' : 'pending', expiresAt }).run();
    const scanUrl = 'http://192.168.1.10:23393/scan/' + 'b'.repeat(64);
    submission.reference = { kind: 'conversation', executionId: 'qr-execution', afterMessageId: null, afterSequence: 0, authorizationNotice: { actionId: 'qr-action', markdown: `![公众号授权二维码](/api/chat/attachments/att_good)\n\n公众号授权页面：${scanUrl}`, scanUrl, expiresAt: new Date(expiresAt.getTime() - (state === 'replaced' ? 1000 : 0)).toISOString() } };
    Object.assign(instance, { executions: { get: async () => { throw new Error('Must not wait for or inspect the running Agent'); } } });
    await deliver();
    if (state === 'completed') expect(messages).toEqual([]);
    else if (state === 'live') { expect(messages.map((message) => message.type)).toEqual([2, 1]); expect(uploads).toEqual([image]); expect(messages[1].text).toContain(scanUrl); }
    else { expect(messages.map((message) => message.type)).toEqual([1]); expect(uploads).toEqual([]); expect(messages[0].text).toContain(scanUrl); }
  });

  it('sends inline Artifacts, binary Artifacts and an attachment as files in exact source order', async () => {
    reply = '说明\n[报告](/api/artifacts/art_report/content)\n[资料](/api/artifacts/art_binary/content?download=true)\n[附件](/api/chat/attachments/att_good?download=true)\n结束';
    await deliver();
    expect(messages.map((message) => message.text ?? message.fileName)).toEqual(['说明', '调研报告.md', '资料 中文.zip', '附件.png', '结束']);
    expect(mediaTypes).toEqual([3, 3, 3]);
    expect(uploads).toEqual([Buffer.from('# 实际产物\n正文'), Buffer.from('opaque-zip-bytes'), image]);
    expect(messages.every((message) => message.contextToken === 'ctx-images')).toBe(true);
    await deliver();
    expect(mediaTypes).toHaveLength(3);
  });

  it('replaces oversized, empty and unavailable files with notices and continues', async () => {
    reply = '[过大](/api/artifacts/art_large/content?download=true)\n[空](/api/artifacts/art_text/content?download=true)\n[缺失](/api/artifacts/art_missing/content?download=true)\n[附件过期](/api/chat/attachments/att_missing?download=true)\n[正常](/api/artifacts/art_binary/content?download=true)';
    await deliver();
    expect(messages.map((message) => message.type)).toEqual([1, 1, 1, 1, 4]);
    expect(messages[0].text).toContain('20 MB');
    expect(messages[1].text).toContain('为空');
    expect(messages[2].text).toContain('不存在');
    expect(messages[3].text).toContain('过期');
    expect(JSON.stringify(messages)).not.toContain('/api/');
    expect(mediaTypes).toEqual([3]);
  });

  it('resumes after failed fallback delivery without duplicating earlier files', async () => {
    reply = '[第一份](/api/artifacts/art_report/content?download=true)\n[第二份](/api/artifacts/art_binary/content?download=true)\n尾声';
    rejectText = '尾声';
    await expect(deliver()).rejects.toThrow('Temporary text send failure');
    rejectText = '';
    await deliver();
    expect(messages.map((message) => message.type)).toEqual([4, 4, 1]);
    expect(mediaTypes).toEqual([3, 3]);

    // A new reply has its own fingerprint. Only a successfully delivered fallback settles it.
    reply = '[被拒](/api/artifacts/art_binary/content?download=true)';
    rejectFileCode = -2; rejectFallback = true;
    await expect(deliver()).rejects.toThrow('Fallback failed');
    rejectFileCode = -2; rejectFallback = false;
    await deliver();
    await deliver();
    expect(messages.at(-1)?.text).toBe('[文件发送失败，请在 WorkLite 查看或稍后重试]');
    expect(messages).toHaveLength(4);
  });

  it('keeps stale-login file failures retryable and resumes with the same client id', async () => {
    const updates: unknown[] = [];
    Object.assign(instance, { configuration: { updateWechat: async (update: unknown) => { updates.push(update); } } });
    reply = '[资料](/api/artifacts/art_binary/content?download=true)';
    rejectFileCode = -14;
    await expect(deliver()).rejects.toMatchObject({ errcode: -14 });
    expect(messages).toEqual([]);
    expect(updates).toEqual([{ wechatStatus: 'error', wechatLastError: '微信登录已过期，请重新扫码登录。' }]);
    await deliver();
    expect(messages.map((message) => message.type)).toEqual([4]);
    expect(fileClientIds).toHaveLength(2);
    expect(fileClientIds[0]).toBe(fileClientIds[1]);
  });

  it('uploads actual artifact and attachment bytes and interleaves every occurrence with text', async () => {
    reply = '之前\n![产物](/api/artifacts/art_good/content)\n之间\n![附件](/api/chat/attachments/att_good)\n![重复产物](/api/artifacts/art_good/content)\n之后';
    await deliver();
    expect(messages.map((message) => message.text ?? '图片')).toEqual(['之前', '图片', '之间', '图片', '图片', '之后']);
    expect(uploads).toEqual([image, image, image]);
    expect(messages.every((message) => message.contextToken === 'ctx-images')).toBe(true);
    expect(new Set(messages.map((message) => message.clientId)).size).toBe(messages.length);
    expect(db.select().from(chatSubmissions).get()!.settled).toBe(true);
  });

  it('replaces missing, non-image and corrupt content without preventing later valid images', async () => {
    reply = '![缺失](/api/artifacts/art_missing/content)\n![文本](/api/artifacts/art_text/content)\n![损坏](/api/artifacts/art_invalid/content)\n![有效](/api/artifacts/art_good/content)';
    await deliver();
    expect(messages.map((message) => message.type)).toEqual([1, 1, 1, 2]);
    expect(messages[0]!.text).toContain('不存在');
    expect(messages[2]!.text).toContain('格式或尺寸无效');
    expect(JSON.stringify(messages)).not.toContain('/api/');
    expect(uploads).toEqual([image]);
    await expect(readArtifactImageContent(db, storage, 'workspace_other', 'art_good')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('sends a readable notice after an API rejection and continues to the next image', async () => {
    rejectNextImage = true;
    reply = '![第一张](/api/artifacts/art_good/content)\n![第二张](/api/artifacts/art_good/content)';
    await deliver();
    expect(messages.map((message) => message.text ?? '图片')).toEqual(['[图片发送失败，请在 WorkLite 查看或稍后重试]', '图片']);
    expect(db.select().from(chatSubmissions).get()!.settled).toBe(true);
  });

  it('does not resend preceding text or images after a later text failure', async () => {
    reply = '之前\n![图](/api/artifacts/art_good/content)\n之后';
    rejectText = '之后';
    await expect(deliver()).rejects.toThrow('Temporary text send failure');
    rejectText = '';
    await deliver();
    expect(messages.map((message) => message.text ?? '图片')).toEqual(['之前', '图片', '之后']);
    expect(uploads).toEqual([image]);
    expect(db.select().from(chatSubmissions).get()!.outputMessageId).toBe('message-3');
  });

  it('delivers all long-reply chunks and later images, resuming after a failed chunk', async () => {
    const prose = Array.from({ length: 1500 }, (_, index) => `第${index}条完整中文回复😀`).join('');
    reply = prose + '\n![图](/api/artifacts/art_good/content)\n**结尾**';
    const expected = formatWechatReply(reply);
    const failedPart = expected[1];
    if (failedPart.kind !== 'text') throw new Error('Expected a text chunk.');
    rejectText = failedPart.text;
    await expect(deliver()).rejects.toThrow('Temporary text send failure');
    expect(messages).toHaveLength(1);
    rejectText = '';
    await deliver();
    await deliver();
    expect(messages.map((message) => message.text ?? '图片')).toEqual(expected.map((part) => part.kind === 'text' ? part.text : '图片'));
    expect(messages.filter((message) => message.text).every((message) => Buffer.byteLength(message.text!) <= WECHAT_TEXT_BYTES)).toBe(true);
    expect(messages.filter((message) => message.text && message.text !== '**结尾**').map((message) => message.text).join('')).toBe(prose);
    expect(uploads).toEqual([image]);
    expect(new Set(messages.map((message) => message.clientId)).size).toBe(messages.length);
    expect(messages.every((message) => message.contextToken === 'ctx-images')).toBe(true);
    expect(db.select().from(chatSubmissions).get()!.settled).toBe(true);
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
    const configuration = {
      wechatSecret: async () => ({ wechatEnabled: true, botToken: 'tok', wechatAllowedUserId: 'user-a', wechatBaseUrl: '', wechatSyncBuf: '' }),
      updateWechat: async (patch: Record<string, unknown>) => { updates.push(patch); },
    };
    const db = { select: emptyQuery, update: emptyQuery, insert: emptyQuery };
    const service = new WechatService(db as never, configuration as never, {} as never, {} as never, {} as never, {} as never, {} as never);
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
