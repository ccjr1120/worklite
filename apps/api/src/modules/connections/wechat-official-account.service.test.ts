// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { and, eq } from 'drizzle-orm';
import { agentExecutions, agentPendingActions, agentPublications, agents, createDb, initializeDatabase, wechatOfficialAccounts, type Database } from '@worklite/db';
import type { PendingNodeExecutionResult } from '@worklite/workflow-engine';
import { WechatOfficialAccountService } from './wechat-official-account.service';

type Session = { browser: Browser; context: BrowserContext; page: Page; headed?: boolean; expiresAt?: number };
type Internals = {
  sessions: Map<string, Session>; activeActionId: string | null;
  assertAccountAvailable(id: string): Promise<void>;
  startLogin(id: string, accountId: string, waiting?: boolean): Promise<PendingNodeExecutionResult['pendingAction']>;
  createSession(): Promise<Session>;
  monitorLogin(id: string, accountId: string, session: Session, expires: Date, waiting: boolean): Promise<void>;
  monitorFailed(id: string, session: Session, error: unknown, accountId: string): Promise<void>;
  closeSession(id: string): Promise<void>;
};
const accountId = 'wechat_official_account_personal';

describe('WeChat authorization session recovery', () => {
  let db: Database;
  let service: WechatOfficialAccountService;
  let internal: Internals;
  function session(expires = Date.now() + 120_000): Session {
    return { browser: { close: vi.fn(async () => {}), isConnected: () => true } as unknown as Browser,
      page: { isClosed: () => false } as unknown as Page, context: {} as BrowserContext, expiresAt: expires };
  }
  function action(id = 'old', expires = new Date(Date.now() + 120_000)) {
    db.insert(agentPendingActions).values({ id, workspaceId: 'workspace_personal', runId: 'execution', nodeRunId: `call-${id}`, type: 'wechat_login', title: 'Login', description: 'Scan', qrCode: 'old-qr', expiresAt: expires }).run();
    db.insert(agentPublications).values({ id: `pub-${id}`, workspaceId: 'workspace_personal', accountId, runId: 'execution', nodeRunId: `call-${id}`, idempotencyKey: `key-${id}`, mode: 'draft', title: 'Article', article: '# Article', status: 'preparing' }).run();
  }
  function occupy(id: string, value: Session) { internal.sessions.set(id, value); internal.activeActionId = id; }
  beforeEach(async () => {
    db = createDb(':memory:'); await initializeDatabase(db);
    db.insert(agents).values({ id: 'publisher', workspaceId: 'workspace_personal', name: 'Publisher', systemPrompt: '', responsibility: 'Test', model: '' }).run();
    db.insert(agentExecutions).values({ id: 'execution', workspaceId: 'workspace_personal', agentId: 'publisher', status: 'running' }).run();
    db.insert(wechatOfficialAccounts).values({ id: accountId, workspaceId: 'workspace_personal', displayName: 'Publisher' }).onConflictDoNothing().run();
    service = new WechatOfficialAccountService(db); internal = service as unknown as Internals;
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.$client.close(); });

  it('reclaims an expired action before admitting a new login and clears the old QR', async () => {
    action('old', new Date(Date.now() - 1)); const old = session(Date.now() - 1); occupy('old', old);
    await internal.assertAccountAvailable('new');
    expect(old.browser.close).toHaveBeenCalledOnce();
    expect(internal.activeActionId).toBe('new');
    expect(db.select().from(agentPendingActions).get()).toMatchObject({ status: 'expired', qrCode: null });
  });

  it('keeps a still-valid action exclusive and reserves the account during browser startup', async () => {
    action(); occupy('old', session());
    await expect(internal.assertAccountAvailable('new')).rejects.toThrow('already handling');
    await internal.closeSession('old');
    const claims = await Promise.allSettled([internal.assertAccountAvailable('first'), internal.assertAccountAvailable('second')]);
    expect(claims.map((claim) => claim.status)).toEqual(['fulfilled', 'rejected']);
  });

  it.each(['closed', 'disconnected', 'cancelled'] as const)('reclaims a %s session without waiting for the QR timer', async (reason) => {
    action(); const old = session();
    if (reason === 'closed') old.page = { isClosed: () => true } as Page;
    if (reason === 'disconnected') old.browser.isConnected = () => false;
    if (reason === 'cancelled') db.update(agentPendingActions).set({ status: 'cancelled' }).where(eq(agentPendingActions.id, 'old')).run();
    occupy('old', old);
    await internal.assertAccountAvailable('new');
    expect(internal.activeActionId).toBe('new'); expect(internal.sessions.has('old')).toBe(false);
  });

  it('resumes the existing unexpired QR without opening a competing login session', async () => {
    action(); occupy('old', session()); const create = vi.spyOn(internal, 'createSession');
    const pending = await internal.startLogin('old', accountId, true);
    expect(pending).toMatchObject({ id: 'old', qrCode: 'old-qr' }); expect(create).not.toHaveBeenCalled();
  });

  it('releases a reservation immediately when Chromium cannot start', async () => {
    vi.spyOn(internal, 'createSession').mockRejectedValue(new Error('Chromium launch failed'));
    await expect(service.startAccountLogin()).rejects.toThrow('Chromium launch failed');
    expect(internal.activeActionId).toBeNull();
    await expect(internal.assertAccountAvailable('next')).resolves.toBeUndefined();
  });

  it('monitor failure expires its action, but an old monitor cannot clear a replacement session', async () => {
    action(); const old = session(); occupy('old', old);
    await internal.monitorFailed('old', old, new Error('Page closed'), accountId);
    expect(internal.activeActionId).toBeNull();
    expect(db.select().from(agentPendingActions).get()?.status).toBe('expired');
    const replacement = session(); occupy('old', replacement);
    await internal.monitorFailed('old', old, new Error('Old request failed'), accountId);
    expect(internal.sessions.get('old')).toBe(replacement);
  });

  it('persists successful login, completes the exact action and notifies its listener', async () => {
    vi.useFakeTimers(); action(); const current = session();
    current.context = { pages: () => [{ url: () => 'https://mp.weixin.qq.com/cgi-bin/home?token=real-session' }], storageState: async () => ({ cookies: [], origins: [] }) } as unknown as BrowserContext;
    occupy('old', current); const completed = vi.fn(); service.subscribe(completed);
    const monitor = internal.monitorLogin('old', accountId, current, new Date(Date.now() + 120_000), true);
    await vi.advanceTimersByTimeAsync(1000); await monitor;
    expect(db.select().from(wechatOfficialAccounts).where(eq(wechatOfficialAccounts.id, accountId)).get()).toMatchObject({ status: 'connected', qrCode: null });
    expect(db.select().from(agentPendingActions).where(and(eq(agentPendingActions.id, 'old'), eq(agentPendingActions.status, 'completed'))).get()).toBeTruthy();
    expect(completed).toHaveBeenCalledExactlyOnceWith('old'); expect(internal.activeActionId).toBeNull();
  });

  it('releases a cancelled action in its live monitor instead of returning with the account occupied', async () => {
    vi.useFakeTimers(); action(); const current = session(); occupy('old', current);
    db.update(agentPendingActions).set({ status: 'cancelled' }).where(eq(agentPendingActions.id, 'old')).run();
    const monitor = internal.monitorLogin('old', accountId, current, new Date(Date.now() + 120_000), true);
    await vi.advanceTimersByTimeAsync(1000); await monitor;
    expect(internal.activeActionId).toBeNull(); expect(current.browser.close).toHaveBeenCalledOnce();
  });

  it('expires and releases a waiting login automatically when its deadline passes', async () => {
    vi.useFakeTimers(); action('old', new Date(Date.now() + 1000));
    const current = session(Date.now() + 1000); occupy('old', current);
    const monitor = internal.monitorLogin('old', accountId, current, new Date(Date.now() + 1000), true);
    await vi.advanceTimersByTimeAsync(1000); await monitor;
    expect(internal.activeActionId).toBeNull();
    expect(db.select().from(agentPendingActions).get()).toMatchObject({ status: 'expired', qrCode: null });
    expect(db.select().from(wechatOfficialAccounts).where(eq(wechatOfficialAccounts.id, accountId)).get()).toMatchObject({ status: 'disconnected', qrCode: null, qrExpiresAt: null });
  });
});
