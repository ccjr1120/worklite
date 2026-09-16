import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { Lexer, type Token, type Tokens } from 'marked';
import { and, eq, ne } from 'drizzle-orm';
import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright';
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
  private readonly listeners = new Set<ActionListener>();
  private readonly sessions = new Map<string, BrowserSession>();
  private activeActionId: string | null = null;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  subscribe(listener: ActionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async execute(request: NodeExecutionRequest): Promise<NodeExecutionResult> {
    const config = asRecord(request.config);
    const input = asRecord(request.input);
    const accountId = typeof config?.accountId === 'string' ? config.accountId : '';
    const mode = config?.mode;
    const article = typeof input?.article === 'string' ? input.article : '';
    const metadata = asRecord(input?.metadata) ?? {};
    if (!accountId || (mode !== 'draft' && mode !== 'publish')) throw new Error('WeChat Official Account node requires an account and mode.');
    if (!article.trim()) throw new Error('WeChat Official Account node requires Markdown article input.');
    const account = await this.getAccountRow(accountId);
    const idempotencyKey = `${request.context.workflowRunId}:${request.context.nodeId}`;
    const publication = await this.ensurePublication(request, accountId, mode, article, metadata, idempotencyKey);
    if (publication.status === 'published' || (mode === 'draft' && publication.status === 'draft_saved')) return { output: toPublicationOutput(publication) };

    if (!account.encryptedStorageState) {
      const pending = await this.startLogin(request.context.pendingActionId, account.id, true);
      return { status: 'waiting_for_input', pendingAction: pending };
    }

    return this.compose(request.context.pendingActionId, publication, account.encryptedStorageState, request.signal);
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
      const qrCode = await captureQrCode(session.page);
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

  private async compose(actionId: string, publication: typeof wechatPublications.$inferSelect, encryptedStorageState: string, signal: AbortSignal): Promise<NodeExecutionResult> {
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
      await fillArticle(session.page, publication.title, publication.article);
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
    while (this.sessions.get(actionId) === session) {
      await delay(1_000);
      if (waitForPendingAction) {
        const actionStatus = await this.getPendingActionStatus(actionId);
        if (!actionStatus || actionStatus === 'expired') continue;
        if (actionStatus !== 'pending') return;
      }
      if (Date.now() >= expiresAt.getTime()) break;
      if (await isLoginConfirmed(session.context)) {
        const storageState = await session.context.storageState();
        await this.db.update(wechatOfficialAccounts).set({ status: 'connected', encryptedStorageState: encryptSecret(JSON.stringify(storageState)), qrCode: null, qrExpiresAt: null, lastVerifiedAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(wechatOfficialAccounts.id, accountId));
        await this.closeSession(actionId);
        this.complete(actionId);
        return;
      }
    }
    if (this.sessions.get(actionId) === session) await this.expire(actionId, accountId);
  }

  private async monitorPublish(actionId: string, publicationId: string, session: BrowserSession, expiresAt: Date): Promise<void> {
    while (this.sessions.get(actionId) === session) {
      await delay(1_000);
      const actionStatus = await this.getPendingActionStatus(actionId);
      if (!actionStatus || actionStatus === 'expired') continue;
      if (actionStatus !== 'pending') return;
      if (Date.now() >= expiresAt.getTime()) break;
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
    const browser = await chromium.launch({ headless: true });
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

async function showScanLogin(page: Page): Promise<void> {
  const qr = page.locator('img.login__type__container__scan__qrcode').first();
  if (await qr.isVisible().catch(() => false)) return;
  await page.locator('a.login__type__container__link_text').first().click();
  await qr.waitFor({ state: 'visible', timeout: 20_000 });
}

async function fillArticle(page: Page, title: string, article: string): Promise<void> {
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
  await setCoverImage(page);
}

async function saveDraft(page: Page): Promise<string | null> {
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes('operate_appmsg') && response.request().method() === 'POST',
    { timeout: 30_000 },
  );
  await clickByText(page, ['Save as draft', 'Save', '\u4fdd\u5b58\u4e3a\u8349\u7a3f', '\u4fdd\u5b58']);
  const response = await responsePromise;
  const body = await response.json().catch(() => null);
  await page.waitForURL((url) => url.searchParams.has('appmsgid'), { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(2_000);
  const draftId = findString(body, ['appMsgId', 'appmsgid', 'appmsgId']);
  return draftId ?? new URL(page.url()).searchParams.get('appmsgid');
}

async function clickByText(page: Page, labels: string[]): Promise<void> {
  for (const label of labels) {
    const target = page.getByText(label, { exact: true }).last();
    if (await target.isVisible().catch(() => false)) {
      await target.click();
      return;
    }
  }
  throw new Error(`WeChat editor action is unavailable: ${labels[0]}`);
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

async function hasAuthenticatedCookies(context: BrowserContext): Promise<boolean> {
  const cookieNames = new Set((await context.cookies()).map((cookie) => cookie.name));
  return ['slave_sid', 'slave_user'].every((name) => cookieNames.has(name));
}

async function isLoginConfirmed(context: BrowserContext): Promise<boolean> {
  return findAuthenticatedPage(context) !== null || await hasAuthenticatedCookies(context);
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
const REFERENCE_TITLE_STYLE = 'font-size:13px;line-height:1.55;color:#3f3f46;font-weight:600;';
const REFERENCE_URL_STYLE = 'margin:2px 0 0;font-size:12px;line-height:1.55;color:#71717a;word-break:break-all;';

function markdownToHtml(markdown: string): string {
  const { articleMarkdown, referenceHeading, referencesMarkdown } = splitReferences(markdown);
  const context = createCitationContext(parseReferenceEntries(referencesMarkdown));
  const articleHtml = renderTokens(Lexer.lex(articleMarkdown), context);
  const referencesHtml = context.entries.length > 0 ? renderReferences(referenceHeading ?? generatedReferenceHeading(markdown), context.entries) : '';
  return `<section style="${ARTICLE_ROOT_STYLE}">${articleHtml}${referencesHtml}</section>`;
}

function generatedReferenceHeading(markdown: string): string {
  return /[一-鿿]/.test(markdown) ? '参考资料' : 'References';
}

function splitReferences(markdown: string): { articleMarkdown: string; referenceHeading: string | null; referencesMarkdown: string } {
  const pattern = /\n?#{1,6}\s*(References|Reference List|Sources|参考资料|引用资料|参考链接)\s*(?=\n|$)/gi;
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
  label = label.replace(/^[\s:：\-–—|]+/, '').replace(/[\s:：\-–—|]+$/, '');
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
    if (entry.url) numbersByUrl.set(entry.url, entry.number);
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
      return `<p style="${PARAGRAPH_STYLE}">${renderInlineTokens(token.tokens, context)}</p>`;
    case 'heading':
      return renderHeading(token.depth, renderInlineTokens(token.tokens, context));
    case 'code':
      return `<section style="${CODE_BLOCK_STYLE}"><code style="${CODE_TEXT_STYLE}">${escapeHtml(token.text)}</code></section>`;
    case 'blockquote':
      return `<section style="${BLOCKQUOTE_STYLE}">${renderTokens(token.tokens, context)}</section>`;
    case 'hr':
      return '<section style="height:1px;margin:30px 0;background:#e4e4e7;font-size:0;line-height:0;">&nbsp;</section>';
    case 'list':
      return renderList(token, context);
    case 'table':
      return renderTable(token, context);
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

function renderInlineToken(token: Token, context: CitationContext): string {
  switch (token.type) {
    case 'text':
    case 'escape':
      return 'tokens' in token && token.tokens ? renderInlineTokens(token.tokens, context) : escapeHtml(token.text);
    case 'strong':
      return `<strong style="color:#18181b;font-weight:600;">${renderInlineTokens(token.tokens, context)}</strong>`;
    case 'em':
      return `<em style="color:#18181b;">${renderInlineTokens(token.tokens, context)}</em>`;
    case 'del':
      return `<del style="color:#71717a;">${renderInlineTokens(token.tokens, context)}</del>`;
    case 'codespan':
      return `<code style="${INLINE_CODE_STYLE}">${escapeHtml(token.text)}</code>`;
    case 'br':
      return '<br>';
    case 'link':
      return renderLink(token, context);
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
  const number = citationNumberFor(url, label, context);
  return `<span style="color:#18181b;font-weight:600;">${escapeHtml(label)}</span><sup style="color:#2563eb;font-size:11px;line-height:1;">[${number}]</sup>`;
}

function plainInlineTokens(tokens: Token[]): string {
  return tokens.map((token) => {
    switch (token.type) {
      case 'text':
      case 'escape':
        return token.tokens ? plainInlineTokens(token.tokens) : token.text;
      case 'strong':
      case 'em':
      case 'del':
        return plainInlineTokens(token.tokens);
      case 'codespan':
        return token.text;
      case 'br':
        return ' ';
      case 'link':
        return plainInlineTokens(token.tokens);
      case 'image':
        return token.text;
      default:
        return '';
    }
  }).join('');
}

function renderReferences(heading: string, entries: ReferenceEntry[]): string {
  const items = entries.map((entry) => `<section style="${REFERENCE_ENTRY_STYLE}"><section style="${REFERENCE_TITLE_STYLE}">${entry.number}. ${escapeHtml(entry.label || (entry.url ? referenceSourceLabel(entry.url) : 'Source'))}</section>${entry.url ? `<section style="${REFERENCE_URL_STYLE}">${escapeHtml(entry.url)}</section>` : ''}</section>`).join('');
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

async function setCoverImage(page: Page): Promise<void> {
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
  const coverPath = await createCoverImage();
  const fileInput = imageDialog.locator('.js_upload_btn_container input[type="file"]').last();
  const existingImageCount = await imageDialog.locator('.weui-desktop-img-picker__item').count();
  await fileInput.setInputFiles(coverPath);
  const imageGrid = imageDialog.locator('.weui-desktop-img-picker__item');
  const uploadStartedAt = Date.now();
  while ((await imageGrid.count()) <= existingImageCount) {
    if (Date.now() - uploadStartedAt > 30_000) {
      await page.screenshot({ path: '/tmp/worklite-cover-upload-timeout.png', fullPage: true });
      throw new Error('Uploaded cover image did not appear.');
    }
    await delay(250);
  }
  await delay(1_000);
  await imageGrid.first().click();
  await delay(1_000);

  const nextButton = imageDialog.getByRole('button', { name: '下一步' }).last();
  await nextButton.waitFor({ state: 'visible', timeout: 30_000 });
  const isNextDisabled = async () => {
    const handle = await nextButton.elementHandle();
    return handle ? await handle.evaluate((element) => element.classList.contains('weui-desktop-btn_disabled')) : true;
  };
  if (await isNextDisabled()) {
    await imageGrid.first().click({ force: true });
    await delay(1_000);
  }
  if (await isNextDisabled()) {
    await imageGrid.first().dispatchEvent('click');
    await delay(1_000);
  }
  try {
    await page.waitForFunction((element) => !element.classList.contains('weui-desktop-btn_disabled'), await nextButton.elementHandle(), { timeout: 30_000 });
  } catch (error) {
    await page.screenshot({ path: '/tmp/worklite-cover-next-timeout.png', fullPage: true });
    throw error;
  }
  await nextButton.click();

  const confirmButton = page
    .locator('button.weui-desktop-btn_primary:visible')
    .filter({ hasText: /^(确认|完成|确定)$/ })
    .last();
  try {
    await confirmButton.waitFor({ state: 'visible', timeout: 20_000 });
    await confirmButton.click({ force: true });
  } catch (error) {
    await page.screenshot({ path: '/tmp/worklite-cover-confirm-timeout.png', fullPage: true });
    throw error;
  }
}

async function createCoverImage(): Promise<string> {
  const width = 900;
  const height = 383;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      raw[offset] = 245;
      raw[offset + 1] = 246;
      raw[offset + 2] = 248;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const typeBuffer = Buffer.from(type, 'ascii');
    const prefix = Buffer.alloc(4);
    const checksum = Buffer.alloc(4);
    prefix.writeUInt32BE(data.length, 0);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([prefix, typeBuffer, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const path = `/tmp/worklite-wechat-cover-${randomUUID()}.png`;
  await import('node:fs/promises').then((fs) => fs.writeFile(path, png));
  return path;
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extractTitle(article: string): string {
  return article.match(/^#\s+(.+)$/m)?.[1]?.trim() || article.trim().split('\n')[0]?.slice(0, 64) || 'Untitled article';
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
