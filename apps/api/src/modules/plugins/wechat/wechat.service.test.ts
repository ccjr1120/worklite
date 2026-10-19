import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorFailureState, WECHAT_CONNECT_FAILURE_ESCALATION_MS, WechatService } from './wechat.service';
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
