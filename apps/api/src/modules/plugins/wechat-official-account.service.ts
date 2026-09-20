import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lexer, type Token, type Tokens } from 'marked';
import { and, eq, ne } from 'drizzle-orm';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Response } from 'playwright';
import type { NodeExecutionRequest, NodeExecutionResult, PendingNodeExecutionResult } from '@worklite/workflow-engine';
import { wechatOfficialAccounts, wechatPublications, workflowPendingActions, type Database } from '@worklite/db';
import type { WechatOfficialAccountView } from '@worklite/contracts';
import { DATABASE } from '../../infrastructure/database.module';
import { decryptSecret, encryptSecret, WECHAT_OFFICIAL_ACCOUNT_ID } from './plugins.service';

type ActionListener = (actionId: string) => void;
type BrowserSession = { browser: Browser; context: BrowserContext; page: Page };

const LOGIN_URL = 'https://mp.weixin.qq.com/';
const QR_LIFETIME_MS = 120_000;

@Injectable()
export class WechatOfficialAccountService {
  private readonly logger = new Logger(WechatOfficialAccountService.name);
  private readonly listeners = new Set<ActionListener>();
  private readonly sessions = new Map<string, BrowserSession>();
  private activeActionId: string | null = null;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  subscribe(listener: ActionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async execute(request: NodeExecutionRequest, version: '1' | '2'): Promise<NodeExecutionResult> {
    const config = asRecord(request.config);
    const input = asRecord(request.input);
    const accountId = typeof config?.accountId === 'string' ? config.accountId : '';
    const mode = config?.mode;
    const article = typeof input?.article === 'string' ? input.article : '';
    const metadata = asRecord(input?.metadata) ?? {};
    if (!accountId || (mode !== 'draft' && mode !== 'publish')) throw new Error('WeChat Official Account node requires an account and mode.');
    if (!article.trim()) throw new Error('WeChat Official Account node requires Markdown article input.');
    const coverImage = version === '2' ? validateGeneratedCover(input?.coverImage) : null;
    const account = await this.getAccountRow(accountId);
    const idempotencyKey = `${request.context.workflowRunId}:${request.context.nodeRunId}`;
    const publication = await this.ensurePublication(request, accountId, mode, article, metadata, idempotencyKey);
    if (publication.status === 'published' || (mode === 'draft' && publication.status === 'draft_saved')) return { output: toPublicationOutput(publication) };

    if (!account.encryptedStorageState) {
      const pending = await this.startLogin(request.context.pendingActionId, account.id, true);
      return { status: 'waiting_for_input', pendingAction: pending };
    }

    if (publication.draftId) {
      if (mode === 'draft') {
        await this.db.update(wechatPublications).set({ status: 'draft_saved', lastError: null, updatedAt: new Date() }).where(eq(wechatPublications.id, publication.id));
        return { output: toPublicationOutput({ ...publication, status: 'draft_saved' }) };
      }
      return { status: 'waiting_for_input', pendingAction: await this.openDraftForConfirmation(request.context.pendingActionId, publication, account.encryptedStorageState) };
    }

    if (!coverImage) return this.compose(request.context.pendingActionId, publication, account.encryptedStorageState, request.signal);
    const coverPath = join(tmpdir(), `worklite-wechat-cover-${randomUUID()}.png`);
    await writeFile(coverPath, Buffer.from(coverImage.b64Json, 'base64'));
    try {
      return await this.compose(request.context.pendingActionId, publication, account.encryptedStorageState, request.signal, coverPath);
    } finally {
      await rm(coverPath, { force: true }).catch(() => undefined);
    }
  }

  async refresh(actionId: string): Promise<PendingNodeExecutionResult['pendingAction']> {
    const [action] = await this.db.select().from(workflowPendingActions).where(eq(workflowPendingActions.id, actionId)).limit(1);
    if (!action) throw new NotFoundException('Pending action not found.');
    await this.closeSession(actionId);
    if (action.type === 'wechat_login') {
      const [publication] = await this.db.select().from(wechatPublications).where(eq(wechatPublications.nodeRunId, action.nodeRunId)).limit(1);
      if (!publication) throw new NotFoundException('WeChat publication not found.');
      return this.startLogin(actionId, publication.accountId, true);
    }
    const [publication] = await this.db.select().from(wechatPublications).where(eq(wechatPublications.nodeRunId, action.nodeRunId)).limit(1);
    if (!publication?.draftId) throw new BadRequestException('The WeChat draft is not available.');
    const account = await this.getAccountRow(publication.accountId);
    if (!account.encryptedStorageState) return this.startLogin(actionId, account.id, true);
    return this.openDraftForConfirmation(actionId, publication, account.encryptedStorageState);
  }

  async startAccountLogin(): Promise<WechatOfficialAccountView> {
    const actionId = `wechat_login_${randomUUID()}`;
    await this.startLogin(actionId, WECHAT_OFFICIAL_ACCOUNT_ID);
    return this.getAccount();
  }

  async disconnect(): Promise<WechatOfficialAccountView> {
    if (this.activeActionId) await this.closeSession(this.activeActionId);
    await this.db.update(wechatOfficialAccounts).set({ status: 'disconnected', encryptedStorageState: null, qrCode: null, qrExpiresAt: null, lastError: null, updatedAt: new Date() }).where(eq(wechatOfficialAccounts.id, WECHAT_OFFICIAL_ACCOUNT_ID));
    return this.getAccount();
  }

  async getAccount(): Promise<WechatOfficialAccountView> {
    const account = await this.getAccountRow(WECHAT_OFFICIAL_ACCOUNT_ID);
    return {
      id: account.id,
      displayName: account.displayName,
      status: account.status,
      qrCode: account.qrCode,
      qrExpiresAt: account.qrExpiresAt?.toISOString() ?? null,
      lastVerifiedAt: account.lastVerifiedAt?.toISOString() ?? null,
      lastError: account.lastError,
      updatedAt: account.updatedAt.toISOString(),
    };
  }

  async cancel(actionId: string): Promise<void> {
    await this.closeSession(actionId);
  }

  private async startLogin(actionId: string, accountId: string, waitForPendingAction = false): Promise<PendingNodeExecutionResult['pendingAction']> {
    this.assertAccountAvailable(actionId);
    const session = await this.createSession();
    this.sessions.set(actionId, session);
    this.activeActionId = actionId;
    try {
      await session.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
      await showScanLogin(session.page);
      const qrCode = await captureLoginQrCode(session.page);
      const expiresAt = new Date(Date.now() + QR_LIFETIME_MS);
      await this.db.update(wechatOfficialAccounts).set({ status: 'qr_pending', qrCode, qrExpiresAt: expiresAt, lastError: null, updatedAt: new Date() }).where(eq(wechatOfficialAccounts.id, accountId));
      void this.monitorLogin(actionId, accountId, session, expiresAt, waitForPendingAction);
      return { id: actionId, type: 'wechat_login', title: 'Scan to sign in to WeChat Official Account', description: 'Use the account administrator WeChat app to scan this QR code. The Workflow will resume automatically.', qrCode, expiresAt };
    } catch (error) {
      await this.failAccount(accountId, error);
      await this.closeSession(actionId);
      throw error;
    }
  }

  private async compose(actionId: string, publication: typeof wechatPublications.$inferSelect, encryptedStorageState: string, signal: AbortSignal, coverPath?: string): Promise<NodeExecutionResult> {
    this.assertAccountAvailable(actionId);
    const session = await this.createSession(encryptedStorageState);
    this.sessions.set(actionId, session);
    this.activeActionId = actionId;
    try {
      await session.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
      if (isLoginPage(session.page)) {
        await this.closeSession(actionId);
        await this.db.update(wechatOfficialAccounts).set({ encryptedStorageState: null, status: 'disconnected', updatedAt: new Date() }).where(eq(wechatOfficialAccounts.id, publication.accountId));
        return { status: 'waiting_for_input', pendingAction: await this.startLogin(actionId, publication.accountId, true) };
      }
      const token = new URL(session.page.url()).searchParams.get('token');
      if (!token) throw new Error('WeChat Official Account session did not provide an editor token.');
      await session.page.goto(`https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=10&token=${encodeURIComponent(token)}&lang=en_US`, { waitUntil: 'domcontentloaded' });
      await fillArticle(session.page, publication.title, publication.article, coverPath);
      if (signal.aborted) throw new Error('Workflow run cancelled.');
      const draftId = await saveDraft(session.page);
      await this.db.update(wechatPublications).set({ status: 'draft_saved', draftId, lastError: null, updatedAt: new Date() }).where(eq(wechatPublications.id, publication.id));
      if (publication.mode === 'draft') {
        await this.closeSession(actionId);
        return { output: toPublicationOutput({ ...publication, status: 'draft_saved', draftId }) };
      }
      return { status: 'waiting_for_input', pendingAction: await this.beginPublishConfirmation(actionId, { ...publication, status: 'draft_saved', draftId }, session) };
    } catch (error) {
      await this.closeSession(actionId);
      await this.db.update(wechatPublications).set({ status: 'failed', lastError: errorMessage(error), updatedAt: new Date() }).where(eq(wechatPublications.id, publication.id));
      throw error;
    }
  }

  private async openDraftForConfirmation(actionId: string, publication: typeof wechatPublications.$inferSelect, encryptedStorageState: string): Promise<PendingNodeExecutionResult['pendingAction']> {
    this.assertAccountAvailable(actionId);
    const session = await this.createSession(encryptedStorageState);
    this.sessions.set(actionId, session);
    this.activeActionId = actionId;
    try {
      await session.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
      const token = new URL(session.page.url()).searchParams.get('token');
      if (!token) throw new Error('WeChat Official Account session expired. Sign in again.');
      await session.page.goto(`https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=10&appmsgid=${encodeURIComponent(publication.draftId ?? '')}&token=${encodeURIComponent(token)}&lang=en_US`, { waitUntil: 'domcontentloaded' });
      return this.beginPublishConfirmation(actionId, publication, session);
    } catch (error) {
      await this.closeSession(actionId);
      throw error;
    }
  }

  private async beginPublishConfirmation(actionId: string, publication: typeof wechatPublications.$inferSelect, session: BrowserSession): Promise<PendingNodeExecutionResult['pendingAction']> {
    await clickByText(session.page, ['Publish', '\u53d1\u8868', '\u7fa4\u53d1']);
    await session.page.waitForFunction(
      `Array.from(document.querySelectorAll('.weui-desktop-dialog')).some((dialog) => dialog.getBoundingClientRect().width > 100 && /Publish|\u53d1\u8868|\u7fa4\u53d1\u901a\u77e5|\u5b9a\u65f6\u53d1\u8868/.test(dialog.textContent ?? ''))`,
      undefined,
      { timeout: 10_000 },
    );
    const clickedDialogPublishButton = await session.page.evaluate<boolean>(`(() => {
      for (const dialog of document.querySelectorAll('.weui-desktop-dialog')) {
        if (dialog.getBoundingClientRect().width < 100) continue;
        for (const button of dialog.querySelectorAll('button')) {
          if (/^(Publish|\u53d1\u8868|\u53d1\u5e03)$/.test(button.textContent?.trim() ?? '') && !button.hasAttribute('disabled')) {
            button.click();
            return true;
          }
        }
      }
      return false;
    })()`);
    if (!clickedDialogPublishButton) {
      await session.page.screenshot({ path: '/tmp/worklite-publish-dialog-button-timeout.png', fullPage: true });
      throw new Error('WeChat publish dialog confirmation is unavailable.');
    }
    await delay(2_000);
    const qrCode = await captureQrCode(session.page);
    const expiresAt = new Date(Date.now() + QR_LIFETIME_MS);
    await this.db.update(wechatPublications).set({ status: 'confirmation_pending', updatedAt: new Date() }).where(and(eq(wechatPublications.id, publication.id), ne(wechatPublications.status, 'published')));
    void this.monitorPublish(actionId, publication.id, session, expiresAt);
    return { id: actionId, type: 'wechat_publish_confirmation', title: 'Confirm WeChat publication', description: 'Scan with the account administrator WeChat app to confirm publication. The Workflow will resume automatically.', qrCode, expiresAt };
  }

  private async monitorLogin(actionId: string, accountId: string, session: BrowserSession, expiresAt: Date, waitForPendingAction: boolean): Promise<void> {
    let lastQrSource = await loginQrCode(session.page).getAttribute('src', { timeout: 1_000 }).catch(() => null);
    let lastDiagnostics = '';
    while (this.sessions.get(actionId) === session) {
      await delay(1_000);
      if (Date.now() >= expiresAt.getTime()) break;
      if (waitForPendingAction) {
        const actionStatus = await this.getPendingActionStatus(actionId);
        if (!actionStatus || actionStatus === 'expired') continue;
        if (actionStatus !== 'pending') return;
      }
      if (await isLoginConfirmed(session.context)) {
        const storageState = await session.context.storageState();
        await this.db.update(wechatOfficialAccounts).set({ status: 'connected', encryptedStorageState: encryptSecret(JSON.stringify(storageState)), qrCode: null, qrExpiresAt: null, lastVerifiedAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(wechatOfficialAccounts.id, accountId));
        await this.closeSession(actionId);
        this.complete(actionId);
        return;
      }
      const diagnostics = await loginDiagnostics(session);
      if (diagnostics !== lastDiagnostics) {
        lastDiagnostics = diagnostics;
        this.logger.debug(`WeChat login ${actionId}: ${diagnostics}`);
      }
      const currentQrSource = await loginQrCode(session.page).getAttribute('src', { timeout: 1_000 }).catch(() => null);
      if (currentQrSource && currentQrSource !== lastQrSource) {
        lastQrSource = currentQrSource;
        const refreshedQrCode = await captureLoginQrCode(session.page).catch(() => null);
        if (refreshedQrCode) {
          await this.db.update(wechatOfficialAccounts).set({ qrCode: refreshedQrCode, updatedAt: new Date() }).where(eq(wechatOfficialAccounts.id, accountId));
          await this.db.update(workflowPendingActions).set({ qrCode: refreshedQrCode, updatedAt: new Date() }).where(and(eq(workflowPendingActions.id, actionId), eq(workflowPendingActions.status, 'pending')));
        }
      }
    }
    if (this.sessions.get(actionId) === session) await this.expire(actionId, accountId);
  }

  private async monitorPublish(actionId: string, publicationId: string, session: BrowserSession, expiresAt: Date): Promise<void> {
    while (this.sessions.get(actionId) === session) {
      await delay(1_000);
      if (Date.now() >= expiresAt.getTime()) break;
      const actionStatus = await this.getPendingActionStatus(actionId);
      if (!actionStatus || actionStatus === 'expired') continue;
      if (actionStatus !== 'pending') return;
      const publishedUrl = await detectPublishedUrl(session.page);
      if (publishedUrl) {
        await this.db.update(wechatPublications).set({ status: 'published', publishedUrl, lastError: null, updatedAt: new Date() }).where(eq(wechatPublications.id, publicationId));
        await this.closeSession(actionId);
        this.complete(actionId);
        return;
      }
    }
    if (this.sessions.get(actionId) === session) await this.expire(actionId);
  }

  private complete(actionId: string): void {
    for (const listener of this.listeners) listener(actionId);
  }

  private async getPendingActionStatus(actionId: string): Promise<string | null> {
    const [action] = await this.db.select({ status: workflowPendingActions.status }).from(workflowPendingActions).where(eq(workflowPendingActions.id, actionId)).limit(1);
    return action?.status ?? null;
  }

  private async expire(actionId: string, accountId?: string): Promise<void> {
    await this.closeSession(actionId);
    if (accountId) await this.db.update(wechatOfficialAccounts).set({ status: 'disconnected', qrCode: null, qrExpiresAt: null, updatedAt: new Date() }).where(eq(wechatOfficialAccounts.id, accountId));
    await this.db.update(workflowPendingActions).set({ status: 'expired', qrCode: null, updatedAt: new Date() }).where(and(eq(workflowPendingActions.id, actionId), eq(workflowPendingActions.status, 'pending')));
  }

  private async createSession(encryptedStorageState?: string): Promise<BrowserSession> {
    const browser = await chromium.launch({ headless: process.env.WECHAT_HEADED !== '1' });
    const context = await browser.newContext(encryptedStorageState ? { storageState: JSON.parse(decryptSecret(encryptedStorageState)) } : undefined);
    const page = await context.newPage();
    return { browser, context, page };
  }

  private assertAccountAvailable(actionId: string): void {
    if (this.activeActionId && this.activeActionId !== actionId) throw new BadRequestException('The WeChat Official Account is already handling another action.');
  }

  private async closeSession(actionId: string): Promise<void> {
    const session = this.sessions.get(actionId);
    this.sessions.delete(actionId);
    if (this.activeActionId === actionId) this.activeActionId = null;
    await session?.browser.close().catch(() => undefined);
  }

  private async ensurePublication(request: NodeExecutionRequest, accountId: string, mode: 'draft' | 'publish', article: string, metadata: Record<string, unknown>, idempotencyKey: string) {
    const [existing] = await this.db.select().from(wechatPublications).where(eq(wechatPublications.idempotencyKey, idempotencyKey)).limit(1);
    if (existing) return existing;
    const title = typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title.trim() : extractTitle(article);
    const [created] = await this.db.insert(wechatPublications).values({ id: `wechat_pub_${randomUUID()}`, workspaceId: request.context.workspaceId, accountId, runId: request.context.workflowRunId, nodeRunId: request.context.nodeRunId, idempotencyKey, mode, status: 'preparing', title, article, metadata }).returning();
    if (!created) throw new Error('Unable to create WeChat publication.');
    return created;
  }

  private async getAccountRow(accountId: string) {
    const [account] = await this.db.select().from(wechatOfficialAccounts).where(eq(wechatOfficialAccounts.id, accountId)).limit(1);
    if (!account) throw new NotFoundException('WeChat Official Account not found.');
    return account;
  }

  private async failAccount(accountId: string, error: unknown): Promise<void> {
    await this.db.update(wechatOfficialAccounts).set({ status: 'error', lastError: errorMessage(error), qrCode: null, qrExpiresAt: null, updatedAt: new Date() }).where(eq(wechatOfficialAccounts.id, accountId));
  }
}

async function captureQrCode(page: Page): Promise<string> {
  const qr = page.locator(
    'img[src*="qrcode"]:not([src*="pic_kf_qrcode"]):visible, img[src*="scan"]:not([src*="pic_kf_qrcode"]):visible, canvas:visible',
  ).last();
  try {
    await qr.waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    await page.screenshot({ path: '/tmp/worklite-publish-qr-timeout.png', fullPage: true });
    throw error;
  }
  return `data:image/png;base64,${(await qr.screenshot()).toString('base64')}`;
}

async function captureLoginQrCode(page: Page): Promise<string> {
  const qr = loginQrCode(page);
  try {
    await qr.waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    await page.screenshot({ path: '/tmp/worklite-login-qr-timeout.png', fullPage: true }).catch(() => undefined);
    throw error;
  }
  return `data:image/png;base64,${(await qr.screenshot()).toString('base64')}`;
}

async function showScanLogin(page: Page): Promise<void> {
  const qr = loginQrCode(page);
  const toggle = page.locator('a.login__type__container__link_text').first();
  await qr.or(toggle).first().waitFor({ state: 'visible', timeout: 20_000 });
  if (await qr.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false)) return;
  await toggle.click();
  await qr.waitFor({ state: 'visible', timeout: 20_000 });
}

function loginQrCode(page: Page) {
  return page.locator('img.login__type__container__scan__qrcode').first();
}

async function fillArticle(page: Page, title: string, article: string, coverPath?: string): Promise<void> {
  const titleEditor = page.locator('.ProseMirror').first();
  await titleEditor.waitFor({ state: 'visible', timeout: 20_000 });
  await titleEditor.click();
  await titleEditor.fill(title.slice(0, 64));

  const bodyEditor = page.locator('.ProseMirror').nth(1);
  await bodyEditor.waitFor({ state: 'visible', timeout: 20_000 });
  await bodyEditor.click();
  const html = markdownToHtml(article.replace(/^#\s+.+$/m, '').trim() || article);
  await bodyEditor.evaluate((element, value) => {
    const view = element.ownerDocument.defaultView;
    if (!view) throw new Error('Missing editor window.');
    const data = new view.DataTransfer();
    data.setData('text/html', value);
    const paste = new view.ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: data });
    element.dispatchEvent(paste);
  }, html);
  // Version 1 nodes have no cover input. Leave the cover unset rather than
  // uploading a substitute image the author never asked for.
  if (coverPath) await setCoverImage(page, coverPath);
}

async function saveDraft(page: Page): Promise<string> {
  const matchingResponses: Response[] = [];
  const captures: unknown[] = [];
  const observed: string[] = [];
  const onResponse = (response: Response): void => {
    if (!response.url().includes('operate_appmsg') || response.request().method() !== 'POST') return;
    observed.push(response.url());
    if (isDraftSaveRequest(response)) matchingResponses.push(response);
  };
  page.on('response', onResponse);
  try {
    await clickByText(page, ['Save as draft', 'Save', '\u4fdd\u5b58\u4e3a\u8349\u7a3f', '\u4fdd\u5b58']);
    await confirmContentStructureWarning(page);

    const deadline = Date.now() + 45_000;
    let acceptedWithoutId = false;
    while (Date.now() < deadline) {
      const response = matchingResponses.shift();
      if (!response) {
        if (acceptedWithoutId) break;
        await delay(250);
        continue;
      }
      const responseText = await response.text().catch(() => '');
      let body: unknown = null;
      try {
        body = JSON.parse(responseText);
      } catch {
        body = null;
      }
      captures.push({
        url: response.url(),
        status: response.status(),
        postData: response.request().postData(),
        body: body ?? responseText,
      });
      const draftId = findString(body, ['appMsgId', 'appmsgid', 'appmsgId']) ?? findDraftIdInText(responseText);
      if (draftId) {
        await waitForDraftIdInUrl(page);
        await page.waitForTimeout(2_000);
        return draftId;
      }
      const rejection = platformRejection(body, responseText);
      if (rejection) throw new Error(`WeChat rejected the draft: ${rejection}`);
      if (platformAcceptedSave(body)) acceptedWithoutId = true;
    }
    if (acceptedWithoutId) {
      const urlDraftId = await waitForDraftIdInUrl(page);
      if (urlDraftId) {
        await page.waitForTimeout(2_000);
        return urlDraftId;
      }
      throw new Error('WeChat accepted the draft but never exposed its draft id.');
    }
    const blockingDialog = await blockingDialogText(page);
    if (blockingDialog) throw new Error(`WeChat blocked the draft with a dialog: ${blockingDialog}`);
    throw new Error('WeChat never answered the draft save request after the editor action was clicked.');
  } catch (error) {
    await page.screenshot({ path: '/tmp/worklite-save-draft-timeout.png', fullPage: true }).catch(() => undefined);
    await writeFile('/tmp/worklite-save-draft-responses.json', JSON.stringify({ pageUrl: page.url(), observedOperateAppmsgUrls: observed, saveResponses: captures }, null, 2), 'utf8').catch(() => undefined);
    throw error;
  } finally {
    page.off('response', onResponse);
  }
}

function findDraftIdInText(value: string): string | null {
  return value.match(/"(?:appMsgId|appmsgid|appmsgId)"\s*:\s*"?([A-Za-z0-9_-]+)/i)?.[1] ?? null;
}

function platformAcceptedSave(body: unknown): boolean {
  const code = findString(body, ['ret', 'errcode', 'err_code']);
  const message = findString(body, ['err_msg', 'errmsg', 'msg']);
  return code === '0' || (code === null && message === 'ok');
}

function platformRejection(body: unknown, responseText: string): string | null {
  if (platformAcceptedSave(body)) return null;
  const message = findString(body, ['err_msg', 'errmsg', 'msg']);
  const code = findString(body, ['ret', 'errcode', 'err_code']);
  if (message && code) return `${message} (${code})`;
  if (message) return message;
  if (code) return `status ${code}`;
  return body === null && responseText.trim() ? responseText.trim().slice(0, 300) : null;
}

const DRAFT_SAVE_SUB_ACTIONS = new Set(['save', 'create', 'update', 'copy']);

function isDraftSaveRequest(response: Response): boolean {
  const url = response.url();
  if (!url.includes('operate_appmsg')) return false;
  const sub = draftSaveSubAction(url) ?? draftSaveSubAction(`?${response.request().postData() ?? ''}`);
  return sub !== null && DRAFT_SAVE_SUB_ACTIONS.has(sub);
}

function draftSaveSubAction(value: string): string | null {
  try {
    const query = value.startsWith('?') ? new URLSearchParams(value.slice(1)) : new URL(value).searchParams;
    return query.get('sub');
  } catch {
    return null;
  }
}

async function waitForDraftIdInUrl(page: Page): Promise<string | null> {
  await page.waitForURL((url) => Boolean(draftIdFromUrl(url.toString())), { timeout: 30_000 }).catch(() => undefined);
  return draftIdFromUrl(page.url());
}

function draftIdFromUrl(value: string): string | null {
  try {
    const id = new URL(value).searchParams.get('appmsgid');
    return id && /^[A-Za-z0-9_-]+$/.test(id) && !/^0+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function blockingDialogText(page: Page): Promise<string | null> {
  return page.evaluate<string | null>(`(() => {
    for (const dialog of document.querySelectorAll('.weui-desktop-dialog__wrp, .weui-desktop-dialog')) {
      if (!(dialog instanceof HTMLElement) || dialog.getBoundingClientRect().width < 100) continue;
      const text = (dialog.textContent ?? '').replace(/\\s+/g, ' ').trim();
      if (text) return text.slice(0, 300);
    }
    return null;
  })()`).catch(() => null);
}

async function confirmContentStructureWarning(page: Page): Promise<void> {
  const warningVisible = await page
    .waitForFunction(
      `Array.from(document.querySelectorAll('.weui-desktop-dialog__wrp, .weui-desktop-dialog')).some((dialog) => /Content structure|\u5185\u5bb9\u7ed3\u6784\u68c0\u6d4b/.test(dialog.textContent ?? ''))`,
      undefined,
      { timeout: 2_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!warningVisible) return;

  const clicked = await page.evaluate<boolean>(`(() => {
    for (const dialog of document.querySelectorAll('.weui-desktop-dialog__wrp, .weui-desktop-dialog')) {
      if (!/Content structure|\u5185\u5bb9\u7ed3\u6784\u68c0\u6d4b/.test(dialog.textContent ?? '')) continue;
      for (const button of dialog.querySelectorAll('button')) {
        if (/^(Continue|Continue saving|Continue inserting|\u7ee7\u7eed|\u7ee7\u7eed\u4fdd\u5b58|\u7ee7\u7eed\u63d2\u5165)$/.test(button.textContent?.trim() ?? '')) {
          button.click();
          return true;
        }
      }
    }
    return false;
  })()`);
  if (!clicked) {
    await page.screenshot({ path: '/tmp/worklite-content-structure-confirm-timeout.png', fullPage: true }).catch(() => undefined);
    throw new Error('WeChat content structure warning confirmation is unavailable.');
  }
}

async function clickByText(page: Page, labels: string[]): Promise<void> {
  for (const label of labels) {
    const target = page.getByText(label, { exact: true }).last();
    if (!await target.isVisible().catch(() => false)) continue;
    if (await clickActionElement(page, label)) return;
  }
  throw new Error(`WeChat editor action is unavailable: ${labels[0]}`);
}

// WeChat renders editor actions as a text span inside the real control, so a
// Playwright click on the matched text can hang on hit-target checks. Dispatch
// the click on the nearest clickable ancestor instead.
async function clickActionElement(page: Page, label: string): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const wanted = ${JSON.stringify(label)}.replace(/\\s+/g, '');
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], .weui-desktop-btn, .js_save, #js_submit'));
    const matches = candidates.filter((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (element.hasAttribute('disabled') || element.classList.contains('weui-desktop-btn_disabled')) return false;
      return (element.textContent ?? '').replace(/\\s+/g, '') === wanted;
    });
    const target = matches[matches.length - 1];
    if (!target) return false;
    target.scrollIntoView({ block: 'center' });
    target.click();
    return true;
  })()`);
}

function isLoginPage(page: Page): boolean {
  const url = page.url();
  return !url.includes('token=') && (url === LOGIN_URL || url.includes('/cgi-bin/loginpage'));
}

function findAuthenticatedPage(context: BrowserContext): Page | null {
  return context.pages().find((page) => {
    try {
      const url = new URL(page.url());
      return url.hostname.endsWith('weixin.qq.com') && url.searchParams.has('token');
    } catch {
      return false;
    }
  }) ?? null;
}

function isLoginConfirmed(context: BrowserContext): boolean {
  return findAuthenticatedPage(context) !== null;
}

async function loginDiagnostics(session: BrowserSession): Promise<string> {
  const cookieNames = new Set((await session.context.cookies().catch(() => [])).map((cookie) => cookie.name));
  const relevant = ['slave_sid', 'slave_user', 'bizuin', 'data_bizuin'].filter((name) => cookieNames.has(name));
  const pages = session.context.pages().map((page) => {
    try {
      const url = new URL(page.url());
      return `${url.hostname}${url.pathname}${url.searchParams.has('token') ? '?token=<present>' : ''}`;
    } catch {
      return page.url() || 'about:blank';
    }
  });
  const mode = await session.page.evaluate<string>(`(() => {
    const qr = document.querySelector('img.login__type__container__scan__qrcode');
    const visible = qr instanceof HTMLElement && qr.getBoundingClientRect().width > 10;
    const account = document.querySelector('input[name="account"], .login__type__container__account');
    return [qr ? (visible ? 'qr:visible' : 'qr:hidden') : 'qr:absent', account ? 'account:present' : 'account:absent'].join(' ');
  })()`).catch(() => 'mode:unavailable');
  return `pages=[${pages.join(' | ')}] cookies=[${relevant.join(',') || 'none'}] total=${cookieNames.size} ${mode}`;
}

async function detectPublishedUrl(page: Page): Promise<string | null> {
  const success = page.getByText(/published successfully|publication successful/i).first();
  if (await success.isVisible().catch(() => false)) return page.url();
  const link = page.locator('a[href*="mp.weixin.qq.com/s/"]').first();
  return await link.getAttribute('href').catch(() => null);
}

type ReferenceEntry = { number: number | null; label: string; url: string | null };
type CitationContext = { entries: ReferenceEntry[]; numbersByUrl: Map<string, number>; nextNumber: number };

const ARTICLE_ROOT_STYLE = "font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;font-size:16px;line-height:1.75;color:#3f3f46;letter-spacing:0.2px;word-break:break-word;";
const PARAGRAPH_STYLE = 'margin:0 0 18px;padding:0;text-align:justify;';
const HEADING_LEVEL_STYLES: Record<number, string> = {
  1: 'margin:38px 0 16px;font-size:22px;line-height:1.45;color:#18181b;font-weight:600;',
  2: 'margin:38px 0 16px;padding-left:10px;border-left:3px solid #2563eb;font-size:20px;line-height:1.45;color:#18181b;font-weight:600;',
  3: 'margin:30px 0 12px;font-size:17px;line-height:1.5;color:#27272a;font-weight:600;',
  4: 'margin:26px 0 10px;font-size:16px;line-height:1.5;color:#27272a;font-weight:600;',
  5: 'margin:24px 0 10px;font-size:16px;line-height:1.5;color:#3f3f46;font-weight:600;',
  6: 'margin:24px 0 10px;font-size:16px;line-height:1.5;color:#3f3f46;font-weight:600;',
};
const CODE_BLOCK_STYLE = 'margin:0 0 18px;padding:14px 16px;background:#f4f4f5;border-radius:6px;overflow-x:auto;';
const CODE_TEXT_STYLE = "font-family:SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;font-size:13px;line-height:1.7;color:#27272a;white-space:pre;";
const INLINE_CODE_STYLE = "padding:2px 5px;background:#f4f4f5;border-radius:4px;font-family:SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;font-size:14px;color:#18181b;";
const BLOCKQUOTE_STYLE = 'margin:0 0 18px;padding:14px 16px;background:#f4f4f5;border-left:3px solid #a1a1aa;border-radius:4px;color:#52525b;';
const REFERENCE_ENTRY_STYLE = 'margin:0 0 10px;';
const REFERENCE_MARKER_STYLE = 'margin-right:4px;font-size:13px;line-height:1.55;color:#3f3f46;font-weight:600;';
const REFERENCE_TITLE_STYLE = 'font-size:13px;line-height:1.55;color:#3f3f46;font-weight:600;';
const REFERENCE_URL_STYLE = 'font-size:12px;line-height:1.55;color:#71717a;word-break:break-all;';

function markdownToHtml(markdown: string): string {
  const { articleMarkdown, referenceHeading, referencesMarkdown } = splitReferences(markdown);
  const context = createCitationContext(parseReferenceEntries(referencesMarkdown));
  const articleHtml = renderTokens(Lexer.lex(articleMarkdown), context);
  const referencesHeading = containsChinese(markdown) ? '相关链接' : referenceHeading ?? generatedReferenceHeading(markdown);
  const referencesHtml = context.entries.length > 0 ? renderReferences(referencesHeading, context.entries) : '';
  return `<section style="${ARTICLE_ROOT_STYLE}">${articleHtml}${referencesHtml}</section>`;
}

function generatedReferenceHeading(markdown: string): string {
  return containsChinese(markdown) ? '相关链接' : 'Related Links';
}

function containsChinese(value: string): boolean {
  return /[一-鿿]/.test(value);
}

function splitReferences(markdown: string): { articleMarkdown: string; referenceHeading: string | null; referencesMarkdown: string } {
  const pattern = /\n?#{1,6}\s*(References|Reference List|Sources|Related Links|参考资料|引用资料|参考链接|相关链接)\s*(?=\n|$)/gi;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = pattern.exec(markdown)) !== null) last = match;
  if (!last) return { articleMarkdown: markdown, referenceHeading: null, referencesMarkdown: '' };
  const headingStart = last.index + (last[0].startsWith('\n') ? 1 : 0);
  return {
    articleMarkdown: markdown.slice(0, headingStart),
    referenceHeading: last[1].trim(),
    referencesMarkdown: markdown.slice(last.index + last[0].length),
  };
}

function parseReferenceEntries(markdown: string): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [];
  for (const originalLine of markdown.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line) continue;
    const explicitNumber = Number(line.match(/^\[?(\d+)[.)\]]\s*/)?.[1] ?? null);
    const linkedSources = [...line.matchAll(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g)];
    if (linkedSources.length > 0) {
      linkedSources.forEach((source, index) => {
        entries.push({ number: index === 0 ? explicitNumber : null, label: cleanReferenceLabel(source[1]), url: source[2] });
      });
      continue;
    }
    const urls = extractUrls(line);
    if (urls.length > 0) {
      urls.forEach((url, index) => {
        entries.push({ number: index === 0 ? explicitNumber : null, label: cleanReferenceLabel(line, url), url });
      });
      continue;
    }
    entries.push({ number: explicitNumber, label: cleanReferenceLabel(line), url: null });
  }
  return deduplicateReferences(entries);
}

function extractUrls(value: string): string[] {
  return [...value.matchAll(/https?:\/\/[^\s<>() [\]{}'"“”‘’]+/gi)].map((match) => {
    let url = match[0];
    while (/[.,;:!?）)\]}>]$/.test(url)) url = url.slice(0, -1);
    return url;
  });
}

function deduplicateReferences(entries: ReferenceEntry[]): ReferenceEntry[] {
  const seen = new Set<string>();
  const result: ReferenceEntry[] = [];
  for (const entry of entries) {
    const key = entry.url ?? entry.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function cleanReferenceLabel(value: string, url?: string): string {
  let label = value
    .replace(/\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s<>() [\]{}'"“”‘’]+/gi, '')
    .replace(/[*_`]+/g, '')
    .replace(/^[-*+]\s*/, '')
    .replace(/^\[?\d+[.)\]]\s*/, '');
  if (url) label = label.split(url).join('');
  // Trailing Chinese commas are stripped too: a source line commonly separates its title from the URL
  // with one, and the rendered entry appends its own separator after the label.
  label = label.replace(/^[\s:：\-–—|]+/, '').replace(/[\s:：，,、;；\-–—|]+$/, '');
  return label || '';
}

function createCitationContext(entries: ReferenceEntry[]): CitationContext {
  const explicitNumbers = entries.map((entry) => entry.number).filter((number): number is number => number !== null);
  let nextNumber = explicitNumbers.length > 0 ? Math.max(...explicitNumbers) + 1 : 1;
  for (const entry of entries) {
    if (entry.number === null) entry.number = nextNumber++;
    if (entry.url && !entry.label) entry.label = referenceSourceLabel(entry.url);
  }
  const numbersByUrl = new Map<string, number>();
  for (const entry of entries) {
    if (entry.url && entry.number !== null) numbersByUrl.set(entry.url, entry.number);
  }
  return { entries, numbersByUrl, nextNumber };
}

function citationNumberFor(url: string, label: string, context: CitationContext): number {
  const existing = context.numbersByUrl.get(url);
  if (existing !== undefined) {
    const entry = context.entries.find((item) => item.url === url);
    if (entry && !entry.label) entry.label = label;
    return existing;
  }
  const number = context.nextNumber++;
  context.entries.push({ number, label: label || referenceSourceLabel(url), url });
  context.numbersByUrl.set(url, number);
  return number;
}

function renderTokens(tokens: Token[], context: CitationContext): string {
  return tokens.map((token) => renderBlockToken(token, context)).join('');
}

function renderBlockToken(token: Token, context: CitationContext): string {
  switch (token.type) {
    case 'space':
    case 'def':
    case 'html':
      return '';
    case 'paragraph':
      return `<p style="${PARAGRAPH_STYLE}">${renderInlineTokens((token as Tokens.Paragraph).tokens, context)}</p>`;
    case 'heading':
      return renderHeading(token.depth, renderInlineTokens((token as Tokens.Heading).tokens, context));
    case 'code':
      return `<section style="${CODE_BLOCK_STYLE}"><code style="${CODE_TEXT_STYLE}">${escapeHtml(token.text)}</code></section>`;
    case 'blockquote':
      return `<section style="${BLOCKQUOTE_STYLE}">${renderTokens((token as Tokens.Blockquote).tokens, context)}</section>`;
    case 'hr':
      return '<section style="height:1px;margin:30px 0;background:#e4e4e7;font-size:0;line-height:0;">&nbsp;</section>';
    case 'list':
      return renderList(token as Tokens.List, context);
    case 'table':
      return renderTable(token as Tokens.Table, context);
    case 'text':
      return token.tokens ? renderInlineTokens(token.tokens, context) : escapeHtml(token.text);
    default:
      return escapeHtml(token.raw);
  }
}

function renderHeading(depth: number, html: string): string {
  const level = Math.min(Math.max(depth, 1), 6);
  return `<h${level} style="${HEADING_LEVEL_STYLES[level]}">${html}</h${level}>`;
}

function renderList(token: Tokens.List, context: CitationContext): string {
  const tag = token.ordered ? 'ol' : 'ul';
  const listStyle = token.ordered ? 'decimal' : 'disc';
  const items = token.items.map((item) => `<li style="margin:0 0 8px;">${renderTokens(item.tokens, context)}</li>`).join('');
  return `<${tag} style="margin:0 0 18px;padding-left:1.35em;list-style-type:${listStyle};">${items}</${tag}>`;
}

function renderTable(token: Tokens.Table, context: CitationContext): string {
  const header = token.header.map((cell) => `<th style="${tableCellStyle(true, cell.align)}">${renderInlineTokens(cell.tokens, context)}</th>`).join('');
  const rows = token.rows.map((row) => `<tr>${row.map((cell) => `<td style="${tableCellStyle(false, cell.align)}">${renderInlineTokens(cell.tokens, context)}</td>`).join('')}</tr>`).join('');
  return `<section style="margin:0 0 18px;overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.6;"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></section>`;
}

function tableCellStyle(header: boolean, align: 'left' | 'center' | 'right' | null): string {
  return `padding:9px 10px;border:1px solid #e4e4e7;text-align:${align ?? 'left'};${header ? 'background:#fafafa;color:#27272a;font-weight:600;' : 'color:#3f3f46;'}`;
}

function renderInlineTokens(tokens: Token[], context: CitationContext): string {
  return tokens.map((token) => renderInlineToken(token, context)).join('');
}

function nestedTokens(token: Token): Token[] {
  return 'tokens' in token && Array.isArray(token.tokens) ? token.tokens : [];
}

function asLinkToken(token: Token): Tokens.Link | null {
  if (token.type !== 'link' || !('href' in token) || typeof token.href !== 'string' || !('tokens' in token) || !Array.isArray(token.tokens)) return null;
  return token as Tokens.Link;
}

function renderInlineToken(token: Token, context: CitationContext): string {
  switch (token.type) {
    case 'text':
    case 'escape':
      return 'tokens' in token && token.tokens ? renderInlineTokens(token.tokens, context) : renderTextWithCitations(token.text, context);
    case 'strong':
      return `<strong style="color:#18181b;font-weight:600;">${renderInlineTokens(nestedTokens(token), context)}</strong>`;
    case 'em':
      return `<em style="color:#18181b;">${renderInlineTokens(nestedTokens(token), context)}</em>`;
    case 'del':
      return `<del style="color:#71717a;">${renderInlineTokens(nestedTokens(token), context)}</del>`;
    case 'codespan':
      return `<code style="${INLINE_CODE_STYLE}">${escapeHtml(token.text)}</code>`;
    case 'br':
      return '<br>';
    case 'link': {
      const link = asLinkToken(token);
      return link ? renderLink(link, context) : escapeHtml(token.raw);
    }
    case 'image':
      return `<img src="${escapeHtml(token.href)}" alt="${escapeHtml(token.text)}" style="display:block;max-width:100%;margin:0 auto 18px;border-radius:4px;">`;
    case 'html':
      return '';
    default:
      return escapeHtml(token.raw);
  }
}

function renderLink(token: Tokens.Link, context: CitationContext): string {
  const url = normalizeHttpUrl(token.href);
  if (!url) return renderInlineTokens(token.tokens, context);
  if (isWechatArticleUrl(url)) {
    return `<a href="${escapeHtml(url)}" style="color:#2563eb;text-decoration:none;border-bottom:1px solid rgba(37,99,235,0.35);">${renderInlineTokens(token.tokens, context)}</a>`;
  }
  const plainText = plainInlineTokens(token.tokens).trim();
  const label = !plainText || token.autolink === true || plainText === url ? referenceSourceLabel(url) : plainText;
  citationNumberFor(url, label, context);
  return `<span style="color:#18181b;font-weight:600;">${escapeHtml(label)}</span>`;
}

function renderTextWithCitations(value: string, context: CitationContext): string {
  let result = '';
  let lastIndex = 0;
  for (const match of value.matchAll(/\[(\d+)\]/g)) {
    const index = match.index ?? 0;
    const marker = match[0];
    const number = Number(match[1]);
    result += escapeHtml(value.slice(lastIndex, index));
    if (!context.entries.some((entry) => entry.number === number)) result += escapeHtml(marker);
    lastIndex = index + marker.length;
  }
  return result + escapeHtml(value.slice(lastIndex));
}

function plainInlineTokens(tokens: Token[]): string {
  return tokens.map((token) => {
    switch (token.type) {
      case 'text':
      case 'escape':
        return nestedTokens(token).length > 0 ? plainInlineTokens(nestedTokens(token)) : token.text;
      case 'strong':
      case 'em':
      case 'del':
        return plainInlineTokens(nestedTokens(token));
      case 'codespan':
        return token.text;
      case 'br':
        return ' ';
      case 'link': {
        const link = asLinkToken(token);
        return link ? plainInlineTokens(link.tokens) : '';
      }
      case 'image':
        return token.text;
      default:
        return '';
    }
  }).join('');
}

// Entries read as `[n] label: url` so a reference matches the `[n]` marker the body already uses.
// The url stays plain text because WeChat strips an off-site anchor from published article bodies.
function renderReferences(heading: string, entries: ReferenceEntry[]): string {
  const items = entries.map((entry) => {
    const label = escapeHtml(entry.label || (entry.url ? referenceSourceLabel(entry.url) : 'Source'));
    const marker = `<span style="${REFERENCE_MARKER_STYLE}">[${entry.number}]</span>`;
    const url = entry.url ? `<span style="${REFERENCE_URL_STYLE}">${escapeHtml(entry.url)}</span>` : '';
    return `<section style="${REFERENCE_ENTRY_STYLE}">${marker}<span style="${REFERENCE_TITLE_STYLE}">${label}${entry.url ? '：' : ''}</span>${url}</section>`;
  }).join('');
  return `${renderHeading(2, escapeHtml(heading))}<section style="margin:0;padding:0;">${items}</section>`;
}

function normalizeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function isWechatArticleUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'mp.weixin.qq.com' || hostname.endsWith('.mp.weixin.qq.com');
  } catch {
    return false;
  }
}

function referenceSourceLabel(value: string): string {
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean);
    if ((url.hostname.toLowerCase() === 'github.com' || url.hostname.toLowerCase() === 'www.github.com') && segments.length >= 2) return `${segments[0]}/${segments[1].replace(/\.git$/, '')}`;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return [host, ...segments.slice(0, 2)].join('/');
  } catch {
    return value;
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

async function setCoverImage(page: Page, coverPath: string): Promise<void> {
  const cover = page.locator('#js_cover_area');
  await cover.waitFor({ state: 'visible', timeout: 20_000 });
  await cover.scrollIntoViewIfNeeded();
  await cover.click();

  const imageLibraryButton = page
    .locator('#js_cover_area .js_imagedialog:visible, #js_cover_null .js_imagedialog:visible')
    .last();
  await imageLibraryButton.waitFor({ state: 'visible', timeout: 10_000 });
  await imageLibraryButton.click();

  const imageDialog = page.locator('.weui-desktop-dialog_img-picker').last();
  await imageDialog.waitFor({ state: 'visible', timeout: 20_000 });
  const fileInput = imageDialog.locator('.js_upload_btn_container input[type="file"]').last();
  const items = imageDialog.locator('.weui-desktop-img-picker__item');
  // The library truncates long file names and does not order the new item
  // first, so identify the upload by the picker items present beforehand.
  // Items render thumbnails through background-image rather than <img>, so
  // compare each item's own rendered identity.
  const before = await pickerItemIdentities(items);
  const beforeKeys = new Set(before.map(thumbnailIdentity));
  await fileInput.setInputFiles(coverPath);
  const uploadDeadline = Date.now() + 30_000;
  let addedIndex = -1;
  let after: string[] = before;
  while (Date.now() < uploadDeadline) {
    after = await pickerItemIdentities(items);
    // A new material shifts every following item, so positional comparison
    // picks a pre-existing thumbnail. Match on identity instead of index.
    addedIndex = after.findIndex((identity) => {
      const key = thumbnailIdentity(identity);
      return key.length >= 32 && !beforeKeys.has(key);
    });
    if (addedIndex >= 0) break;
    await delay(500);
  }
  if (addedIndex < 0) {
    await page.screenshot({ path: '/tmp/worklite-cover-upload-timeout.png', fullPage: true }).catch(() => undefined);
    await writeFile('/tmp/worklite-cover-upload-dom.json', JSON.stringify({ before, after }, null, 2), 'utf8').catch(() => undefined);
    throw new Error(`WeChat did not add the uploaded cover image to the material library. The picker held ${before.length} items before the upload and ${after.length} after.`);
  }
  const uploadedImage = items.nth(addedIndex);
  await uploadedImage.waitFor({ state: 'visible', timeout: 10_000 });
  await delay(1_000);
  await uploadedImage.click();
  await delay(1_000);

  const nextButton = imageDialog.getByRole('button', { name: '下一步' }).last();
  await nextButton.waitFor({ state: 'visible', timeout: 30_000 });
  const isNextDisabled = async () => {
    const handle = await nextButton.elementHandle();
    return handle ? await handle.evaluate((element) => element.classList.contains('weui-desktop-btn_disabled')) : true;
  };
  if (await isNextDisabled()) {
    await uploadedImage.click({ force: true });
    await delay(1_000);
  }
  if (await isNextDisabled()) {
    await uploadedImage.dispatchEvent('click');
    await delay(1_000);
  }
  try {
    await page.waitForFunction((element) => !element.classList.contains('weui-desktop-btn_disabled'), await nextButton.elementHandle(), { timeout: 30_000 });
  } catch (error) {
    await page.screenshot({ path: '/tmp/worklite-cover-next-timeout.png', fullPage: true });
    throw error;
  }
  await nextButton.click();

  // The picker keeps every step's buttons in one dialog and hides the inactive
  // ones at zero size, so a text match can lock onto the picker's own hidden
  // confirmation instead of the crop step's. The crop step appears only after
  // its image loads, so poll every visible dialog for a confirmation that has
  // real layout rather than pre-selecting a dialog.
  const confirmLabels = ['确认', '完成', '确定', '确认并保存', '保存', '使用', 'OK'];
  const visibleDialogs = page.locator('.weui-desktop-dialog:visible');
  const confirmDeadline = Date.now() + 60_000;
  let confirmation: DialogButtonAttempt = { clicked: false, rejected: [] };
  while (!confirmation.clicked && Date.now() < confirmDeadline) {
    await confirmContentStructureWarning(page);
    const count = await visibleDialogs.count().catch(() => 0);
    for (let index = 0; index < count && !confirmation.clicked; index += 1) {
      confirmation = await clickDialogButton(visibleDialogs.nth(index), confirmLabels).catch(() => ({ clicked: false, rejected: [] }));
    }
    if (!confirmation.clicked) await delay(500);
  }
  if (!confirmation.clicked) {
    await page.screenshot({ path: '/tmp/worklite-cover-confirm-timeout.png', fullPage: true }).catch(() => undefined);
    const available = await visibleDialogButtons(page);
    await writeFile('/tmp/worklite-cover-confirm-dom.json', JSON.stringify({ rejected: confirmation.rejected, dialogs: available }, null, 2), 'utf8').catch(() => undefined);
    await writeFile('/tmp/worklite-cover-crop-dialog.json', JSON.stringify(await describeDialogControls(visibleDialogs.last()), null, 2), 'utf8').catch(() => undefined);
    const why = confirmation.rejected.map((entry) => `${entry.text}(${entry.width}x${entry.height}${entry.disabled ? ',disabled' : ''})`).join(' ') || 'no label matched';
    throw new Error(`WeChat did not expose a usable cover crop confirmation control. Rejected candidates: ${why}. Visible dialogs: ${available.map((entry) => `[${entry.buttons.join('|')}]`).join(' ') || 'none'}.`);
  }

  await assertCoverImageApplied(page);
}

type ClickableElement = {
  textContent: string | null;
  getBoundingClientRect(): { width: number; height: number };
  hasAttribute(name: string): boolean;
  classList: { contains(token: string): boolean };
  click(): void;
};

// Reports the visible dialogs and their button labels so a missing control is
// diagnosable from one failed run instead of another guess at the markup.
async function visibleDialogButtons(page: Page): Promise<Array<{ dialog: string; buttons: string[] }>> {
  return page.evaluate<Array<{ dialog: string; buttons: string[] }>>(`(() => {
    return Array.from(document.querySelectorAll('.weui-desktop-dialog, .weui-desktop-dialog__wrp, [role="dialog"]'))
      .filter((dialog) => dialog.getBoundingClientRect().width > 50)
      .map((dialog) => ({
        dialog: (dialog.className || dialog.tagName).toString().slice(0, 90),
        buttons: Array.from(dialog.querySelectorAll('button, [role="button"], a.weui-desktop-btn'))
          .map((button) => (button.textContent ?? '').replace(/\\s+/g, ''))
          .filter(Boolean)
          .slice(0, 20),
      }));
  })()`);
}

type DialogButtonAttempt = { clicked: boolean; rejected: Array<{ text: string; width: number; height: number; disabled: boolean }> };

// Records every control in the dialog with its own box and its ancestors', so a
// zero-size label can be told apart from a genuinely hidden control.
async function describeDialogControls(dialog: Locator): Promise<unknown> {
  return dialog.evaluate((element: {
    getBoundingClientRect(): { width: number; height: number };
    querySelectorAll(selector: string): ArrayLike<{
      textContent: string | null;
      tagName: string;
      className: unknown;
      getBoundingClientRect(): { width: number; height: number };
      parentElement: { tagName: string; className: unknown; getBoundingClientRect(): { width: number; height: number } } | null;
    }>;
  }) => ({
    dialogBox: element.getBoundingClientRect(),
    controls: Array.from(element.querySelectorAll('button, [role="button"], a, input[type="submit"], .weui-desktop-btn, .weui-desktop-btn_wrp')).map((node) => ({
      tag: node.tagName,
      text: (node.textContent ?? '').replace(/\s+/g, '').slice(0, 20),
      className: String(node.className).slice(0, 80),
      box: node.getBoundingClientRect(),
      parent: node.parentElement ? { tag: node.parentElement.tagName, className: String(node.parentElement.className).slice(0, 80), box: node.parentElement.getBoundingClientRect() } : null,
    })),
  }));
}



async function clickDialogButton(dialog: Locator, labels: string[]): Promise<DialogButtonAttempt> {
  return dialog.evaluate((element: { querySelectorAll(selector: string): ArrayLike<ClickableElement> }, wanted: string[]) => {
    const rejected: Array<{ text: string; width: number; height: number; disabled: boolean }> = [];
    for (const button of Array.from(element.querySelectorAll('button, [role="button"], a'))) {
      const text = (button.textContent ?? '').replace(/\s+/g, '');
      if (!wanted.includes(text)) continue;
      const rect = button.getBoundingClientRect();
      const disabled = button.hasAttribute('disabled') || button.classList.contains('weui-desktop-btn_disabled');
      if (rect.width > 0 && rect.height > 0 && !disabled) {
        button.click();
        return { clicked: true, rejected };
      }
      rejected.push({ text, width: Math.round(rect.width), height: Math.round(rect.height), disabled });
    }
    return { clicked: false, rejected };
  }, labels);
}

// WeChat renders material thumbnails as CSS background images on <i> and <div>
// elements rather than <img>, both in the picker grid and in the cover preview.
// Collect every material reference a subtree exposes, whichever form it uses.
async function materialReferences(root: Locator): Promise<string[]> {
  return root.evaluateAll((elements) => elements.flatMap((element) => {
    const view = element.ownerDocument.defaultView;
    const found: string[] = [];
    for (const node of [element, ...Array.from(element.querySelectorAll('*'))]) {
      const source = node.getAttribute('src') ?? node.getAttribute('data-src') ?? '';
      if (source) found.push(source);
      const background = view?.getComputedStyle(node).backgroundImage ?? '';
      if (background && background !== 'none') found.push(background);
    }
    return found;
  }));
}

// One picker item's identity, used to tell a newly uploaded material apart.
async function pickerItemIdentities(items: Locator): Promise<string[]> {
  return items.evaluateAll((elements) => elements.map((element) => {
    const view = element.ownerDocument.defaultView;
    for (const node of [element, ...Array.from(element.querySelectorAll('*'))]) {
      const source = node.getAttribute('src') ?? node.getAttribute('data-src') ?? '';
      if (source) return source;
      const background = view?.getComputedStyle(node).backgroundImage ?? '';
      if (background && background !== 'none') return background;
    }
    return (element.textContent ?? '').trim();
  }));
}

// A wrong material selection is a failure, not something to publish silently,
// so confirm the cover area now renders the image that was just uploaded.
// Confirms the cover area left its empty state and now renders an uploaded
// material. WeChat re-keys a material between the upload preview, the library
// entry and the applied cover, so the specific id cannot be matched across
// those stages; what is verifiable is that a real material replaced the
// add-cover placeholder, which renders as an inline SVG icon.
async function assertCoverImageApplied(page: Page): Promise<void> {
  const deadline = Date.now() + 20_000;
  let rendered: string[] = [];
  while (Date.now() < deadline) {
    rendered = await materialReferences(page.locator('#js_cover_area'));
    if (rendered.some(isUploadedMaterialReference)) return;
    await delay(500);
  }
  await page.screenshot({ path: '/tmp/worklite-cover-mismatch.png', fullPage: true }).catch(() => undefined);
  await writeFile('/tmp/worklite-cover-mismatch.json', JSON.stringify({ coverArea: rendered }, null, 2), 'utf8').catch(() => undefined);
  throw new Error(`WeChat left the cover unset. The cover area shows ${rendered.length ? rendered.map(thumbnailIdentity).join(', ') : 'no image'}.`);
}

function isUploadedMaterialReference(value: string): boolean {
  if (/^data:|svg\+xml/i.test(value)) return false;
  if (/\/mpres\//.test(value)) return false;
  return /mmbiz/.test(value);
}

// The picker and the cover area serve the same material from different CDN
// prefixes (/mmbiz_png/ versus /sz_mmbiz_png/) and with different query
// strings, so compare the material id segment rather than the whole path.
function thumbnailIdentity(value: string): string {
  const url = value.match(/url\(["']?(.*?)["']?\)/)?.[1] ?? value;
  try {
    const segments = new URL(url, 'https://mp.weixin.qq.com').pathname.split('/').filter(Boolean);
    return segments.find((segment) => segment.length >= 32) ?? segments.join('/');
  } catch {
    return url;
  }
}

function validateGeneratedCover(value: unknown): { b64Json: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WeChat Official Account v2 requires a generated cover image.');
  const cover = value as Record<string, unknown>;
  if (cover.type !== 'workflow_image' || cover.mediaType !== 'image/png' || !Array.isArray(cover.data) || cover.data.length === 0) throw new Error('WeChat Official Account v2 requires a generated PNG cover image.');
  const first = cover.data[0];
  if (!first || typeof first !== 'object' || Array.isArray(first) || typeof (first as Record<string, unknown>).b64Json !== 'string' || !(first as Record<string, unknown>).b64Json) throw new Error('WeChat Official Account v2 requires generated PNG image data.');
  return first as { b64Json: string };
}


function extractTitle(article: string): string {
  const heading = article.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  const firstLine = article.trim().split('\n')[0]?.trim();
  return firstLine ? firstLine.replace(/^#{1,6}\s+/, '').slice(0, 64) : 'Untitled article';
}

function findString(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (keys.includes(key) && (typeof child === 'string' || typeof child === 'number')) return String(child);
    const nested = findString(child, keys);
    if (nested) return nested;
  }
  return null;
}

function toPublicationOutput(publication: typeof wechatPublications.$inferSelect): unknown {
  return { type: 'wechat_publication', publicationId: publication.id, status: publication.status, draftId: publication.draftId, publishedUrl: publication.publishedUrl };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'WeChat browser operation failed.';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
