import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lexer, type Token, type Tokens } from 'marked';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Response } from 'playwright';
import type { NodeExecutionRequest, NodeExecutionResult, PendingNodeExecutionResult } from '@worklite/workflow-engine';
import { wechatOfficialAccounts, wechatPublications, workflowPendingActions, type Database } from '@worklite/db';
import type { WechatOfficialAccountView } from '@worklite/contracts';
import { DATABASE } from '../../infrastructure/database.module';
import { decryptSecret, encryptSecret, WECHAT_OFFICIAL_ACCOUNT_ID } from './plugins.service';
import { applyInlineImageUrls, findInlineImageReferences, INLINE_IMAGE_PLACEHOLDER, planInlineImageUploads, validateGeneratedInlineImages, type GeneratedInlineImage } from './wechat-article-images';
import { inspectQrPng } from './qr-png';

type ActionListener = (actionId: string) => void;
type BrowserSession = { browser: Browser; context: BrowserContext; page: Page; headed?: boolean };
type QrSourceEvaluation = {
  sourceKind: 'image-url' | 'image-data-url' | 'image-blob-url' | 'canvas' | 'none' | 'unsupported';
  sourceMimeType: string | null;
  width: number | null;
  height: number | null;
  failure: string | null;
};
type QrEncodeResult = { dataUrl: string | null; failure: string | null };

const LOGIN_URL = 'https://mp.weixin.qq.com/';
const QR_LIFETIME_MS = 120_000;
// A visible login browser is driven by a person, so it outlives the scannable
// lifetime of a single QR code.
const BROWSER_LOGIN_LIFETIME_MS = 15 * 60_000;
// Opening the window is a foreground request, so cap the whole launch-and-load
// sequence across every candidate browser.
const BROWSER_LAUNCH_BUDGET_MS = 60_000;
const QR_CAPTURE_TIMEOUT_MS = 15_000;
// A scannable QR covers a modest share of its own bitmap. Anything outside
// this band is a blank, solid or otherwise unusable capture.
const QR_MIN_DARK_RATIO = 0.01;
const QR_MAX_DARK_RATIO = 0.85;
// Playwright's own Chromium is the fallback: a browser a person has to sign in
// through works far better as the Chrome or Edge they already use.
const LOGIN_BROWSER_CHANNELS: Array<string | undefined> = ['chrome', 'msedge', undefined];

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
    const inlineImages = version === '2' ? validateGeneratedInlineImages(input?.images) : [];
    // Resolve dangling placeholders before opening a browser session: a bad
    // article should fail with one readable node error, not a half-filled draft.
    planInlineImageUploads(article, inlineImages);
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

    if (!coverImage) return this.compose(request.context.pendingActionId, publication, account.encryptedStorageState, request.signal, inlineImages);
    const coverPath = join(tmpdir(), `worklite-wechat-cover-${randomUUID()}.png`);
    await writeFile(coverPath, Buffer.from(coverImage.b64Json, 'base64'));
    try {
      return await this.compose(request.context.pendingActionId, publication, account.encryptedStorageState, request.signal, inlineImages, coverPath);
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

  /**
   * Open the official login page in a browser window on the WorkLite host so a
   * person can sign in with any method the page offers. It replaces the
   * headless QR session for the same action: two concurrent login sessions on
   * one account invalidate each other's codes.
   */
  async openLoginInBrowser(actionId: string): Promise<Date> {
    const [action] = await this.db.select().from(workflowPendingActions).where(eq(workflowPendingActions.id, actionId)).limit(1);
    if (!action) throw new NotFoundException('Pending action not found.');
    if (action.type !== 'wechat_login' || (action.status !== 'pending' && action.status !== 'expired')) {
      throw new BadRequestException('Browser login is only available for a waiting WeChat Official Account login.');
    }
    const [publication] = await this.db.select().from(wechatPublications).where(eq(wechatPublications.nodeRunId, action.nodeRunId)).limit(1);
    if (!publication) throw new NotFoundException('WeChat publication not found.');

    const existing = this.sessions.get(actionId);
    if (existing?.headed && !existing.page.isClosed()) {
      await existing.page.bringToFront().catch(() => undefined);
      const expiresAt = new Date(Date.now() + BROWSER_LOGIN_LIFETIME_MS);
      await this.extendPendingAction(actionId, expiresAt);
      return expiresAt;
    }
    this.assertAccountAvailable(actionId);

    // Launch before taking over, so a host that cannot open a login browser
    // leaves the existing QR session untouched instead of stranding the Run.
    let session: BrowserSession;
    try {
      session = await this.openLoginBrowser();
    } catch (error) {
      throw new BadRequestException(`Unable to open the WeChat Official Account login browser: ${errorMessage(error)}`);
    }
    await this.closeSession(actionId);
    await this.resetAccountForLogin(publication.accountId);
    this.sessions.set(actionId, session);
    this.activeActionId = actionId;
    const expiresAt = new Date(Date.now() + BROWSER_LOGIN_LIFETIME_MS);
    try {
      // The page is left on whichever panel it opens with. Unlike the headless
      // capture, a person can reach either login method by clicking, and
      // steering the panels here would fight their own clicks.
      await session.page.bringToFront().catch(() => undefined);
      await this.extendPendingAction(actionId, expiresAt);
      void this.monitorLogin(actionId, publication.accountId, session, expiresAt, true);
      return expiresAt;
    } catch (error) {
      await this.closeSession(actionId);
      throw new BadRequestException(`Unable to open the WeChat Official Account login browser: ${errorMessage(error)}`);
    }
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
    // Clear the error left by an earlier attempt up front, so a transient
    // capture failure cannot leave the account reading as broken once a new
    // attempt is under way.
    await this.resetAccountForLogin(accountId);
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

  private async compose(actionId: string, publication: typeof wechatPublications.$inferSelect, encryptedStorageState: string, signal: AbortSignal, inlineImages: GeneratedInlineImage[] = [], coverPath?: string): Promise<NodeExecutionResult> {
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
      await session.page.goto(`https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&isNew=1&type=10&token=${encodeURIComponent(token)}&lang=en_US`, { waitUntil: 'domcontentloaded' });
      await fillArticle(session.page, publication.title, publication.article, inlineImages, coverPath);
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

  /**
   * Change the title and selected inline images of a draft this platform saved,
   * leaving the article text exactly as recorded. Everything before the save
   * click is checked against the publication record; a mismatch stops the
   * revision with the draft untouched. Once save is clicked, any failure that
   * is not an explicit platform rejection is reported as uncertain.
   */
  async reviseExistingDraft(input: {
    revisionId: string;
    publication: typeof wechatPublications.$inferSelect;
    title?: string;
    replacements: ReadonlyMap<string, Buffer>;
    onSaveClicked: () => Promise<void>;
    /** Run only the read-only checks against the draft and change nothing. */
    verifyOnly?: boolean;
  }): Promise<DraftRevisionOutcome> {
    const { publication } = input;
    if (!publication.draftId) throw new DraftRevisionError('failed', 'The publication has no saved draft id.');
    const actionId = `wechat_revision_${input.revisionId}`;
    const account = await this.getAccountRow(publication.accountId);
    if (!account.encryptedStorageState) throw new DraftRevisionError('failed', 'The WeChat Official Account is not signed in. Sign in from the plugin settings first.');
    this.assertAccountAvailable(actionId);
    const session = await this.createSession(account.encryptedStorageState);
    this.sessions.set(actionId, session);
    this.activeActionId = actionId;
    const { page } = session;
    // The editor may persist content on its own. A save the revision did not
    // request means a later stop can no longer promise the draft is untouched.
    let unrequestedSaves = 0;
    let saveClicked = false;
    const onResponse = (response: Response): void => {
      if (!saveClicked && response.request().method() === 'POST' && isDraftSaveRequest(response)) unrequestedSaves += 1;
    };
    page.on('response', onResponse);
    const stop = (message: string): never => {
      throw new DraftRevisionError(unrequestedSaves > 0 ? 'uncertain' : 'failed', unrequestedSaves > 0
        ? `${message} The editor saved on its own ${unrequestedSaves} time(s) before WorkLite stopped, so the draft may hold partial changes.`
        : message);
    };
    try {
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
      if (isLoginPage(page)) throw new DraftRevisionError('failed', 'The WeChat Official Account sign-in has expired. Sign in again from the plugin settings first.');
      const token = new URL(page.url()).searchParams.get('token');
      if (!token) throw new DraftRevisionError('failed', 'The WeChat Official Account session did not provide an editor token. Sign in again first.');
      await page.goto(`https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=10&appmsgid=${encodeURIComponent(publication.draftId)}&token=${encodeURIComponent(token)}&lang=en_US`, { waitUntil: 'domcontentloaded' });
      const titleEditor = page.locator('.ProseMirror').first();
      await titleEditor.waitFor({ state: 'visible', timeout: 20_000 });
      const bodyEditor = await articleEditor(page);
      await bodyEditor.waitFor({ state: 'visible', timeout: 20_000 });
      if (draftIdFromUrl(page.url()) !== publication.draftId) stop(`The editor opened draft ${draftIdFromUrl(page.url()) ?? 'unknown'} instead of ${publication.draftId}; nothing was changed.`);

      const articleBody = articleBodyMarkdown(publication.article);
      const references = findInlineImageReferences(articleBody);
      const expectedText = await renderedTextOf(page, markdownToHtml(articleBody));
      const before = await readArticleBody(bodyEditor);
      if (before.text !== expectedText) {
        stop(`The draft body no longer matches the recorded article (${describeTextDifference(expectedText, before.text)}). It may have been edited in the WeChat backend; nothing was changed.`);
      }
      if (before.images.length !== references.length) {
        stop(`The draft holds ${before.images.length} body images but the recorded article has ${references.length} image placeholders; nothing was changed.`);
      }
      for (const key of input.replacements.keys()) {
        if (!references.some((reference) => reference.key === key)) stop(`The recorded article has no image "${key}"; nothing was changed.`);
      }
      const currentUrls = new Map<string, string>();
      references.forEach((reference, index) => {
        if (!currentUrls.has(reference.key)) currentUrls.set(reference.key, before.images[index]!);
      });
      const previousTitle = await titleEditor.innerText().then((value) => value.trim()).catch(() => '');
      if (input.verifyOnly) {
        return {
          draftId: publication.draftId,
          previousTitle,
          title: previousTitle,
          images: references.map((reference, index) => ({ position: index + 1, key: reference.key, url: before.images[index]! })),
          bodyWrittenThrough: 'none',
        };
      }

      // Placeholders that keep their image take the draft's current URL; the
      // replaced ones are uploaded and resolved by the shared upload path.
      const pending = articleBody.replace(INLINE_IMAGE_PLACEHOLDER, (raw, alt: string, key: string) => (input.replacements.has(key) ? raw : `![${alt}](${currentUrls.get(key)})`));
      let renderedArticle = pending;
      if (input.replacements.size > 0) {
        await bodyEditor.click();
        renderedArticle = await uploadInlineArticleImages(page, pending, [...input.replacements].map(([key, png]) => ({ key, b64Json: png.toString('base64') })));
      }
      const html = markdownToHtml(renderedArticle);
      const expectedImages = [...renderedArticle.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => thumbnailIdentity(match[1]!));
      const bodyWrittenThrough = await setArticleBodyThroughEditorApi(page, html, true) ? 'editor_api' as const : 'paste' as const;
      if (bodyWrittenThrough === 'paste') await pasteArticleBody(page, bodyEditor, html);
      if (input.title !== undefined) {
        await titleEditor.click();
        await titleEditor.fill(input.title.slice(0, 64));
      } else {
        await titleEditor.click();
      }
      await assertArticleBody(bodyEditor, renderedArticle, html).catch((error: unknown) => stop(errorMessage(error)));
      const after = await readArticleBody(bodyEditor);
      if (after.text !== expectedText) stop(`The revised body text differs from the recorded article (${describeTextDifference(expectedText, after.text)}); the draft was not saved.`);
      const afterImages = after.images.map(thumbnailIdentity);
      if (afterImages.join('\n') !== expectedImages.join('\n')) stop(`The revised body images do not match the planned order (${afterImages.length} of ${expectedImages.length}); the draft was not saved.`);
      if (input.title !== undefined) {
        const shownTitle = (await titleEditor.innerText()).trim();
        if (shownTitle !== input.title.slice(0, 64)) stop(`The editor shows the title "${shownTitle}" instead of the requested one; the draft was not saved.`);
      }

      await input.onSaveClicked();
      saveClicked = true;
      let savedDraftId: string;
      try {
        savedDraftId = await saveDraft(page);
      } catch (error) {
        const message = errorMessage(error);
        // An explicit platform rejection means nothing was stored.
        if (message.startsWith('WeChat rejected the draft')) throw new DraftRevisionError('failed', message);
        throw new DraftRevisionError('uncertain', `Save was clicked but its result is unknown: ${message}`);
      }
      if (savedDraftId !== publication.draftId) {
        throw new DraftRevisionError('uncertain', `Save returned draft ${savedDraftId} instead of ${publication.draftId}; the change may have been stored as a separate draft.`);
      }
      return {
        draftId: savedDraftId,
        previousTitle,
        title: input.title ?? previousTitle,
        images: references.map((reference, index) => ({ position: index + 1, key: reference.key, url: [...renderedArticle.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)][index]?.[1] ?? '' })),
        bodyWrittenThrough,
      };
    } catch (error) {
      if (error instanceof DraftRevisionError) throw error;
      if (saveClicked) throw new DraftRevisionError('uncertain', `Save was clicked but its result is unknown: ${errorMessage(error)}`);
      return stop(errorMessage(error));
    } finally {
      page.off('response', onResponse);
      await this.closeSession(actionId);
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
    let lastQrSource = waitForPendingAction ? null : await loginQrCode(session.page).getAttribute('src', { timeout: 1_000 }).catch(() => null);
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
        if (waitForPendingAction) await this.restorePendingActionForCompletion(actionId);
        await this.closeSession(actionId);
        this.complete(actionId);
        return;
      }
      const diagnostics = await loginDiagnostics(session);
      if (diagnostics !== lastDiagnostics) {
        lastDiagnostics = diagnostics;
        this.logger.debug(`WeChat login ${actionId}: ${diagnostics}`);
      }
      if (!waitForPendingAction) {
        const currentQrSource = await loginQrCode(session.page).getAttribute('src', { timeout: 1_000 }).catch(() => null);
        if (currentQrSource && currentQrSource !== lastQrSource) {
          lastQrSource = currentQrSource;
          const refreshedQrCode = await captureLoginQrCode(session.page).catch(() => null);
          if (refreshedQrCode) {
            await this.db.update(wechatOfficialAccounts).set({ qrCode: refreshedQrCode, updatedAt: new Date() }).where(eq(wechatOfficialAccounts.id, accountId));
          }
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
    const headless = process.env.WECHAT_HEADED !== '1';
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext(encryptedStorageState ? { storageState: JSON.parse(decryptSecret(encryptedStorageState)) } : undefined);
    const page = await context.newPage();
    return { browser, context, page, headed: !headless };
  }

  /**
   * Launch a visible browser that actually renders the login page. Chromium
   * builds and installed browsers differ in what they can load here, so try
   * each in turn and keep only a window that reached a real login panel —
   * returning a window stuck on a network error page is what leaves a person
   * staring at "this page cannot be loaded".
   */
  private async openLoginBrowser(): Promise<BrowserSession> {
    const deadline = Date.now() + BROWSER_LAUNCH_BUDGET_MS;
    const failures: string[] = [];
    for (const channel of LOGIN_BROWSER_CHANNELS) {
      if (Date.now() >= deadline) break;
      const label = channel ?? 'bundled chromium';
      let session: BrowserSession | null = null;
      try {
        const browser = await chromium.launch(channel ? { headless: false, channel } : { headless: false });
        const context = await browser.newContext();
        session = { browser, context, page: await context.newPage(), headed: true };
        await this.loadLoginPage(session.page, deadline);
        return session;
      } catch (error) {
        failures.push(`${label}: ${errorMessage(error)}`);
        if (session) await session.browser.close().catch(() => undefined);
      }
    }
    throw new Error(`no browser on this host could load the WeChat Official Account login page (${failures.join('; ') || 'launch budget exhausted'})`);
  }

  /** Reached a real login panel, not a browser window parked on an error page. */
  private async loadLoginPage(page: Page, deadline: number): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 2_000) break;
      if (attempt > 0) await delay(1_000);
      try {
        // The URL is fixed here and never supplied by a request.
        const response = await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: Math.min(20_000, remaining) });
        if (response && response.status() >= 400) throw new Error(`login page responded with HTTP ${response.status()}`);
        await page.locator('.login__type__container__account, .login__type__container__scan').first().waitFor({ state: 'attached', timeout: Math.max(2_000, Math.min(15_000, deadline - Date.now())) });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('the login page did not render a login panel in time');
  }

  /** Keep a login the user is still working through from reading as expired. */
  private async extendPendingAction(actionId: string, expiresAt: Date): Promise<void> {
    await this.db.update(workflowPendingActions).set({ status: 'pending', expiresAt, updatedAt: new Date() })
      .where(and(eq(workflowPendingActions.id, actionId), inArray(workflowPendingActions.status, ['pending', 'expired'])));
  }

  /**
   * A login that already succeeded has to resume its Run even when the QR it
   * started from timed out in the meantime: the Run scheduler only picks up a
   * pending action.
   */
  private async restorePendingActionForCompletion(actionId: string): Promise<void> {
    const now = new Date();
    await this.db.update(workflowPendingActions).set({ status: 'pending', expiresAt: new Date(now.getTime() + QR_LIFETIME_MS), updatedAt: now })
      .where(and(eq(workflowPendingActions.id, actionId), eq(workflowPendingActions.status, 'expired')));
  }

  private async resetAccountForLogin(accountId: string): Promise<void> {
    await this.db.update(wechatOfficialAccounts).set({ status: 'qr_pending', qrCode: null, qrExpiresAt: null, lastError: null, updatedAt: new Date() })
      .where(and(eq(wechatOfficialAccounts.id, accountId), ne(wechatOfficialAccounts.status, 'connected')));
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
  const selector = 'img[src*="qrcode"]:not([src*="pic_kf_qrcode"]), img[src*="scan"]:not([src*="pic_kf_qrcode"]), canvas';
  const qr = page.locator('img[src*="qrcode"]:not([src*="pic_kf_qrcode"]):visible, img[src*="scan"]:not([src*="pic_kf_qrcode"]):visible, canvas:visible').last();
  try {
    await qr.waitFor({ state: 'visible', timeout: 20_000 });
    await waitForScannableQrCode(page, selector);
  } catch (error) {
    await page.screenshot({ path: '/tmp/worklite-publish-qr-timeout.png', fullPage: true });
    throw new Error(`WeChat publication QR code did not load as a scannable image: ${errorMessage(error)}`);
  }
  return captureQrBitmap(page, selector, qr);
}

async function captureLoginQrCode(page: Page): Promise<string> {
  const selector = 'img.login__type__container__scan__qrcode';
  const qr = page.locator(`${selector}:visible`).last();
  try {
    await qr.waitFor({ state: 'visible', timeout: 20_000 });
    await waitForScannableQrCode(page, selector);
  } catch (error) {
    await page.screenshot({ path: '/tmp/worklite-login-qr-timeout.png', fullPage: true }).catch(() => undefined);
    throw new Error(`WeChat login QR code did not load as a scannable image: ${errorMessage(error)}`);
  }
  return captureQrBitmap(page, selector, qr);
}

/**
 * Turn the live QR element into a PNG data URL the Web UI can render.
 *
 * The login page swaps and re-fades its QR element while it refreshes, so a
 * single attempt races that churn. Each attempt tries two independent
 * strategies, because either one alone has a blind spot: re-encoding the source
 * bitmap in the page keeps the intrinsic pixels and ignores CSS opacity but
 * fails on a cross-origin tainted canvas, while an element screenshot always
 * reads back but can catch a faded or covered element as blank. Every candidate
 * is validated as a complete PNG that carries QR-shaped ink before it is
 * accepted, and the whole loop keeps retrying until the deadline.
 */
async function captureQrBitmap(page: Page, selector: string, qr: Locator): Promise<string> {
  const deadline = Date.now() + QR_CAPTURE_TIMEOUT_MS;
  let latest: QrSourceEvaluation | null = null;
  const failures = new Map<string, string>();
  do {
    try {
      const encoded = await page.evaluate<QrEncodeResult>(QR_BITMAP_DATA_URL, selector);
      const accepted = acceptQrPng(encoded.dataUrl);
      if (typeof accepted === 'string') return accepted;
      failures.set('page-bitmap', encoded.failure ?? accepted.reason);
    } catch (error) {
      failures.set('page-bitmap', errorMessage(error));
    }

    try {
      const screenshot = await qr.screenshot({ type: 'png', animations: 'disabled', timeout: Math.max(100, Math.min(1_000, deadline - Date.now())) });
      const accepted = acceptQrPng(`data:image/png;base64,${screenshot.toString('base64')}`);
      if (typeof accepted === 'string') return accepted;
      failures.set('element-screenshot', accepted.reason);
    } catch (error) {
      // The login page can replace the QR element while it refreshes. Retry a
      // transient detach, but retain the last capture failure for diagnostics.
      failures.set('element-screenshot', errorMessage(error));
    }

    // Only needed to describe a failed attempt, so probe the source after both
    // strategies have already declined this one.
    try {
      latest = await page.evaluate<QrSourceEvaluation>(QR_SOURCE_INFO, selector);
    } catch (error) {
      latest = null;
      failures.set('source', `inspection failed: ${errorMessage(error)}`);
    }

    if (Date.now() < deadline) await page.waitForTimeout(100);
  } while (Date.now() < deadline);

  const input = latest
    ? `${latest.sourceKind}${latest.sourceMimeType ? ` (${latest.sourceMimeType})` : ''}${latest.width && latest.height ? ` ${latest.width}x${latest.height}` : ''}`
    : 'unavailable';
  if (latest?.failure) failures.set('source', latest.failure);
  const reason = failures.size > 0 ? [...failures].map(([strategy, detail]) => `${strategy}: ${detail}`).join('; ') : 'invalid PNG image data';
  throw new Error(`WeChat QR image could not be converted to a PNG data URL. Input: ${input}; attempts over ${QR_CAPTURE_TIMEOUT_MS}ms: ${reason}.`);
}

/** The normalized data URL, or why this candidate is not a usable QR image. */
function acceptQrPng(candidate: string | null): string | { reason: string } {
  if (!candidate) return { reason: 'no image data' };
  const inspection = inspectQrPng(candidate);
  if (!inspection) return { reason: 'not a complete PNG of at least 64x64' };
  const { darkRatio } = inspection;
  if (darkRatio === null) return inspection.dataUrl;
  if (darkRatio < QR_MIN_DARK_RATIO) return { reason: `blank capture, only ${(darkRatio * 100).toFixed(2)}% dark pixels in ${inspection.width}x${inspection.height}` };
  if (darkRatio > QR_MAX_DARK_RATIO) return { reason: `solid capture, ${(darkRatio * 100).toFixed(2)}% dark pixels in ${inspection.width}x${inspection.height}` };
  return inspection.dataUrl;
}

// Playwright evaluates this expression inside the page. Keep it as a string so
// the Node TypeScript build does not try to resolve browser-only DOM globals.
const SCANNABLE_QR_PREDICATE = `(qrSelector) => {
  const visible = (element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return element.isConnected && bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const candidates = Array.from(document.querySelectorAll(qrSelector)).filter(visible);
  const element = candidates[candidates.length - 1];
  if (!element) return false;

  let source;
  if (element instanceof HTMLImageElement) {
    if (!element.complete || element.naturalWidth < 64 || element.naturalHeight < 64) return false;
    source = document.createElement('canvas');
    source.width = element.naturalWidth;
    source.height = element.naturalHeight;
    const context = source.getContext('2d', { willReadFrequently: true });
    if (!context) return false;
    try {
      context.drawImage(element, 0, 0);
    } catch {
      return false;
    }
  } else if (element instanceof HTMLCanvasElement && element.width >= 64 && element.height >= 64) {
    source = element;
  } else {
    return false;
  }

  const context = source.getContext('2d', { willReadFrequently: true });
  if (!context) return false;
  try {
    const pixels = context.getImageData(0, 0, source.width, source.height).data;
    let darkPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] < 140 && pixels[index + 1] < 140 && pixels[index + 2] < 140 && pixels[index + 3] > 0) darkPixels += 1;
    }
    const totalPixels = pixels.length / 4;
    return darkPixels >= Math.max(64, Math.ceil(totalPixels * 0.01)) && darkPixels <= totalPixels * 0.85;
  } catch {
    return false;
  }
}`;

// A QR may arrive as a remote/data/blob image URL or as a page canvas. The
// browser decodes that source and re-encodes its pixels as PNG; the source URL
// itself is never copied into the pending action or diagnostic message.
const QR_SOURCE_INFO = `(qrSelector) => {
  const visible = (element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return element.isConnected && bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const candidates = Array.from(document.querySelectorAll(qrSelector)).filter(visible);
  const element = candidates[candidates.length - 1];
  if (!element) return { sourceKind: 'none', sourceMimeType: null, width: null, height: null, failure: 'no-visible-qr-image' };

  let width;
  let height;
  let sourceKind;
  let sourceMimeType = null;
  if (element instanceof HTMLImageElement) {
    const sourceUrl = element.currentSrc || element.src;
    const isDataUrl = sourceUrl.toLowerCase().startsWith('data:');
    sourceKind = isDataUrl ? 'image-data-url' : sourceUrl.toLowerCase().startsWith('blob:') ? 'image-blob-url' : 'image-url';
    sourceMimeType = isDataUrl ? (/^data:([^;,]+)/i.exec(sourceUrl)?.[1]?.toLowerCase() || null) : null;
    if (!element.complete || element.naturalWidth < 64 || element.naturalHeight < 64) {
      return { sourceKind, sourceMimeType, width: element.naturalWidth || null, height: element.naturalHeight || null, failure: 'image-not-decoded' };
    }
    width = element.naturalWidth;
    height = element.naturalHeight;
  } else if (element instanceof HTMLCanvasElement && element.width >= 64 && element.height >= 64) {
    width = element.width;
    height = element.height;
    sourceKind = 'canvas';
  } else {
    return { sourceKind: 'unsupported', sourceMimeType: null, width: null, height: null, failure: 'unsupported-qr-element' };
  }

  return { sourceKind, sourceMimeType, width, height, failure: null };
}`;

// Re-encode the source bitmap rather than a screenshot of the composited page
// element, so a CSS opacity or transition on a freshly refreshed QR cannot turn
// a valid code into a blank image, and the intrinsic pixel size is preserved.
// A cross-origin QR taints the canvas and makes toDataURL throw; that is
// reported so the caller can fall back to a screenshot.
const QR_BITMAP_DATA_URL = `(qrSelector) => {
  const visible = (element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return element.isConnected && bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const candidates = Array.from(document.querySelectorAll(qrSelector)).filter(visible);
  const element = candidates[candidates.length - 1];
  if (!element) return { dataUrl: null, failure: 'no-visible-qr-image' };

  let width;
  let height;
  if (element instanceof HTMLImageElement) {
    if (!element.complete || element.naturalWidth < 64 || element.naturalHeight < 64) return { dataUrl: null, failure: 'image-not-decoded' };
    width = element.naturalWidth;
    height = element.naturalHeight;
  } else if (element instanceof HTMLCanvasElement && element.width >= 64 && element.height >= 64) {
    width = element.width;
    height = element.height;
  } else {
    return { dataUrl: null, failure: 'unsupported-qr-element' };
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return { dataUrl: null, failure: 'no-2d-context' };
  // A QR drawn as dark ink on transparency stays scannable only over white.
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  try {
    context.drawImage(element, 0, 0, width, height);
  } catch (error) {
    return { dataUrl: null, failure: 'draw-failed: ' + (error && error.message ? error.message : String(error)) };
  }
  try {
    return { dataUrl: canvas.toDataURL('image/png'), failure: null };
  } catch (error) {
    return { dataUrl: null, failure: 'canvas-tainted: ' + (error && error.message ? error.message : String(error)) };
  }
}`;

async function waitForScannableQrCode(page: Page, selector: string): Promise<void> {
  await page.waitForFunction(SCANNABLE_QR_PREDICATE, selector, { timeout: 20_000, polling: 100 });
}

async function showScanLogin(page: Page): Promise<void> {
  const qr = loginQrCode(page);
  const accountPanel = page.locator('.login__type__container__account').first();
  const scanPanel = page.locator('.login__type__container__scan').first();
  await accountPanel.or(scanPanel).first().waitFor({ state: 'attached', timeout: 20_000 });
  // The login page opens on the account-password panel or on the scan panel's
  // fast-login iframe, and only the scan panel's direct QR image is capturable.
  // Walk towards it — switching the account panel to scan login, or revealing
  // the direct QR behind the fast-login iframe — and keep retrying until the
  // overall deadline in case a late re-render resets the panel state.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await qr.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) return;
    if (Date.now() >= deadline) break;
    if (await accountPanel.isVisible().catch(() => false)) {
      // The account-password panel is active: switch it to scan login. WeChat's
      // panel handlers can ignore untrusted DOM clicks, so click for real and
      // fall back to a DOM click only when the link renders without layout.
      const switchToScan = page.locator('a.login__type__container__select-type__scan').first();
      await switchToScan.click({ timeout: 3_000 }).catch(() =>
        switchToScan.evaluate(`element => { if (element instanceof HTMLElement) element.click(); }`).catch(() => undefined));
    } else if (await scanPanel.isVisible().catch(() => false)) {
      // The scan panel shows the fast-login iframe first: reveal the direct QR.
      // Click only while the 扫码登录 entry is visible — once the direct QR
      // panel is showing, its click target is the 微信快捷登录 switch-back.
      const toggle = page.locator('a.login__type__container__link_text').filter({ hasText: '扫码登录' }).first();
      if (await toggle.isVisible().catch(() => false)) {
        await toggle.click({ timeout: 3_000 }).catch(() =>
          toggle.evaluate(`element => { if (element instanceof HTMLElement) element.click(); }`).catch(() => undefined));
      }
    }
  }
  await qr.waitFor({ state: 'visible', timeout: 20_000 });
}

function loginQrCode(page: Page) {
  return page.locator('img.login__type__container__scan__qrcode').first();
}

async function fillArticle(page: Page, title: string, article: string, inlineImages: GeneratedInlineImage[], coverPath?: string): Promise<void> {
  const titleEditor = page.locator('.ProseMirror').first();
  await titleEditor.waitFor({ state: 'visible', timeout: 20_000 });
  await titleEditor.click();
  await titleEditor.fill(title.slice(0, 64));

  const bodyEditor = await articleEditor(page);
  await bodyEditor.waitFor({ state: 'visible', timeout: 20_000 });
  const articleBody = article.replace(/^#\s+.+$/m, '').trim() || article;
  // Inline materials are selected into the editor before their canonical
  // image URL is read. Keep the body editor focused so those temporary images
  // land in the body; the content API below replaces them with the final HTML.
  await bodyEditor.click();
  const renderedArticle = await uploadInlineArticleImages(page, articleBody, inlineImages);
  const html = markdownToHtml(renderedArticle);
  // The article editor is ProseMirror, so pasted markup is reparsed against its
  // schema and the inline styles the article depends on are dropped. Hand the
  // HTML to the editor's own content API first and keep the paste as a fallback.
  if (!await setArticleBodyThroughEditorApi(page, html)) await pasteArticleBody(page, bodyEditor, html);
  await titleEditor.click();
  await assertArticleBody(bodyEditor, renderedArticle, html);
  // Version 1 nodes have no cover input. Leave the cover unset rather than
  // uploading a substitute image the author never asked for.
  if (coverPath) await setCoverImage(page, coverPath);
}

// WeChat renders the title in its own ProseMirror instance and can mount the
// article editor later, so the article editor is resolved by excluding the
// title, then by its placeholder, and only then by the larger editing surface.
async function articleEditor(page: Page): Promise<Locator> {
  const position = await page.waitForFunction(`(() => {
    const nodes = Array.from(document.querySelectorAll('.ProseMirror'));
    const candidates = nodes.filter((node) => !node.closest('.title-editor__input'));
    if (candidates.length === 0) return 0;
    const area = (node) => node.clientWidth * node.clientHeight;
    const placeholder = candidates.find((node) => /\u4ece\u8fd9\u91cc\u5f00\u59cb\u5199\u6b63\u6587|Start writing/.test(node.textContent ?? ''));
    const chosen = placeholder ?? candidates.slice().sort((a, b) => area(b) - area(a))[0];
    return nodes.indexOf(chosen) + 1;
  })()`, undefined, { timeout: 20_000 }).then((handle) => handle.jsonValue() as Promise<number>);
  return page.locator('.ProseMirror').nth(position - 1);
}

// The editor exposes mp_editor_get_isready and mp_editor_set_content on the
// page, and the content call is only accepted while the editor reports itself
// as new, which is why the editor is opened with isNew.
async function setArticleBodyThroughEditorApi(page: Page, html: string, allowExistingDraft = false): Promise<boolean> {
  return page.evaluate(async ({ content, allowExisting }: { content: string; allowExisting: boolean }) => {
    type EditorApiResult = { ok: boolean; result?: { isReady?: boolean; isNew?: boolean } };
    const api = (globalThis as unknown as { __MP_Editor_JSAPI__?: { invoke?: (options: unknown) => void } }).__MP_Editor_JSAPI__;
    if (!api || typeof api.invoke !== 'function') return false;
    const invoke = (apiName: string, apiParam: unknown): Promise<EditorApiResult> => new Promise((resolve) => {
      let settled = false;
      const finish = (value: EditorApiResult): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        api.invoke?.({ apiName, apiParam, sucCb: (result: EditorApiResult['result']) => finish({ ok: true, result }), errCb: () => finish({ ok: false }) });
      } catch {
        finish({ ok: false });
      }
      setTimeout(() => finish({ ok: false }), 5_000);
    });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const state = await invoke('mp_editor_get_isready', {});
      if (state.ok && state.result?.isReady) {
        if (!state.result.isNew && !allowExisting) return false;
        return (await invoke('mp_editor_set_content', { content })).ok;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  }, { content: html, allowExisting: allowExistingDraft });
}

export type DraftRevisionOutcome = {
  draftId: string;
  previousTitle: string;
  title: string;
  images: Array<{ position: number; key: string; url: string }>;
  bodyWrittenThrough: 'editor_api' | 'paste' | 'none';
};

/** A revision stopped before save (failed) or after it with an unknown result (uncertain). */
export class DraftRevisionError extends Error {
  constructor(readonly outcome: 'failed' | 'uncertain', message: string) {
    super(message);
    this.name = 'DraftRevisionError';
  }
}

/** The article body as the node writes it: the leading H1 is the title, not body text. */
export function articleBodyMarkdown(article: string): string {
  return article.replace(/^#\s+.+$/m, '').trim() || article;
}

/** Text compared between the record and the editor; layout whitespace is not article text. */
export function comparableArticleText(value: string): string {
  return value.replace(/[\s\u00a0\u200b-\u200d\u2060\ufeff]+/g, '');
}

export function describeTextDifference(expected: string, actual: string): string {
  const limit = Math.min(expected.length, actual.length);
  let index = 0;
  while (index < limit && expected[index] === actual[index]) index += 1;
  const around = (value: string) => JSON.stringify(value.slice(Math.max(0, index - 8), index + 16));
  return `first difference at character ${index}: expected ${around(expected)}, found ${around(actual)}; lengths ${expected.length} and ${actual.length}`;
}

// The expected text is read from the same HTML the editor received, through an
// inert template so no image or script in it loads.
async function renderedTextOf(page: Page, html: string): Promise<string> {
  type InertDocument = { createElement(tag: 'template'): { innerHTML: string; content: { textContent: string | null } } };
  const text = await page.evaluate((content: string) => {
    const template = (globalThis as unknown as { document: InertDocument }).document.createElement('template');
    template.innerHTML = content;
    return template.content.textContent ?? '';
  }, html);
  return comparableArticleText(text);
}

type EditorImage = { classList: { contains(name: string): boolean }; getAttribute(name: string): string | null };

async function readArticleBody(bodyEditor: Locator): Promise<{ text: string; images: string[] }> {
  const body = await bodyEditor.evaluate((element) => ({
    text: element.textContent ?? '',
    images: (Array.from(element.querySelectorAll('img')) as unknown as EditorImage[])
      .filter((image) => !image.classList.contains('ProseMirror-separator'))
      .map((image) => image.getAttribute('data-src') || image.getAttribute('src') || ''),
  }));
  return { text: comparableArticleText(body.text), images: body.images };
}

async function pasteArticleBody(page: Page, bodyEditor: Locator, html: string): Promise<void> {
  await bodyEditor.click();
  const plainText = htmlToPlainText(html);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://mp.weixin.qq.com' });
  const copied = await page.evaluate(async ({ richText, text }) => {
    const browser = globalThis as unknown as {
      navigator?: { clipboard?: { write(items: unknown[]): Promise<void> } };
      ClipboardItem?: new (items: Record<string, Blob>) => unknown;
    };
    if (!browser.navigator?.clipboard || !browser.ClipboardItem) return false;
    await browser.navigator.clipboard.write([
      new browser.ClipboardItem({
        'text/html': new Blob([richText], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ]);
    return true;
  }, { richText: html, text: plainText });
  if (!copied) throw new Error('The browser could not prepare formatted article content for the WeChat editor.');
  await bodyEditor.press('ControlOrMeta+A');
  await bodyEditor.press('Backspace');
  await bodyEditor.press('ControlOrMeta+V');
}

async function assertArticleBody(bodyEditor: Locator, article: string, html: string): Promise<void> {
  // A leading illustration has no text to look for, so the first paragraph
  // check skips image-only lines instead of reading their Markdown as prose.
  const expectedLine = article.replace(/^#\s+.+$/m, '').split(/\r?\n/)
    .map((line) => line.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim())
    .find((line) => line && !line.startsWith('#'));
  const expectedExcerpt = expectedLine?.replace(/^>\s*/, '').replace(/[*_`]/g, '').slice(0, 32);
  const structure = await bodyEditor.evaluate((element) => ({
    text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
    blockCount: element.querySelectorAll('p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,table').length,
    styledCount: element.querySelectorAll('[style]').length,
    imageCount: element.querySelectorAll('img').length,
  }));
  const expectedBlockCount = html.match(/<(?:p|h[1-6]|blockquote|ul|ol|table)\b/g)?.length ?? 0;
  const expectedStyledCount = html.match(/\sstyle="/g)?.length ?? 0;
  if (!expectedExcerpt || !structure.text.includes(expectedExcerpt)) throw new Error('WeChat article body did not retain its first paragraph after leaving the editor.');
  if (expectedBlockCount > 1 && structure.blockCount < 2) throw new Error('WeChat editor flattened the article instead of retaining its formatted blocks.');
  // Block structure survives even when every inline style is discarded, which
  // is how an unstyled article reached readers through a successful run.
  if (expectedStyledCount > 0 && structure.styledCount * 2 < expectedStyledCount) {
    throw new Error(`WeChat editor discarded the article styles: ${structure.styledCount} of ${expectedStyledCount} styled elements remain.`);
  }
  const expectedImageCount = html.match(/<img\b/g)?.length ?? 0;
  if (expectedImageCount > structure.imageCount) throw new Error(`WeChat editor dropped inline images: ${structure.imageCount} of ${expectedImageCount} remain.`);
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

const ARTICLE_STYLE_COLORS = {
  accent: '#008d83',
  accentSurface: '#ddf0ed',
  accentBar: '#a8d8d4',
  accentUnderline: '#9ed4d0',
  text: '#292b30',
  mutedText: '#777b83',
  neutralSurface: '#f3f5f7',
  rule: '#d9dee3',
  tableRule: '#dfe3e6',
  tableHeader: '#303943',
  tableHeaderText: '#f8fafc',
} as const;
const ARTICLE_ROOT_STYLE = `font-size:16px;line-height:1.9;color:${ARTICLE_STYLE_COLORS.text};letter-spacing:0.24px;word-break:break-word;`;
const PARAGRAPH_STYLE = `margin:0 0 18px;padding:0;text-align:justify;text-indent:2em;font-size:16px;line-height:1.9;color:${ARTICLE_STYLE_COLORS.text};letter-spacing:0.24px;word-break:break-word;`;
const LEAD_PARAGRAPH_STYLE = `margin:0 0 18px;padding:0 0 0 15px;border-left:2px solid ${ARTICLE_STYLE_COLORS.rule};text-align:justify;text-indent:2em;font-size:17px;font-weight:500;line-height:1.82;color:${ARTICLE_STYLE_COLORS.text};letter-spacing:0.24px;word-break:break-word;`;
const HEADING_LEVEL_STYLES: Record<number, string> = {
  1: `margin:34px 0 16px;font-size:28px;line-height:1.4;color:${ARTICLE_STYLE_COLORS.accent};font-weight:600;letter-spacing:-0.4px;`,
  2: `margin:32px 0 16px;padding:7px 12px;border-left:3px solid ${ARTICLE_STYLE_COLORS.accentBar};border-radius:0 6px 6px 0;background:${ARTICLE_STYLE_COLORS.accentSurface};font-size:19px;line-height:1.5;color:${ARTICLE_STYLE_COLORS.accent};font-weight:600;letter-spacing:-0.16px;`,
  3: `margin:25px 0 12px;padding-bottom:7px;border-bottom:1px solid ${ARTICLE_STYLE_COLORS.rule};font-size:16px;line-height:1.55;color:${ARTICLE_STYLE_COLORS.accent};font-weight:600;`,
  4: `margin:22px 0 10px;font-size:16px;line-height:1.5;color:${ARTICLE_STYLE_COLORS.accent};font-weight:600;`,
  5: `margin:20px 0 10px;font-size:15px;line-height:1.5;color:${ARTICLE_STYLE_COLORS.accent};font-weight:600;`,
  6: `margin:20px 0 10px;font-size:15px;line-height:1.5;color:${ARTICLE_STYLE_COLORS.accent};font-weight:600;`,
};
const HEADING_UNDERLINE_STYLE = `display:block;width:24px;height:2px;margin-top:7px;background:${ARTICLE_STYLE_COLORS.accentUnderline};font-size:0;line-height:0;`;
const CODE_LINE_STYLE = `margin:0;padding:3px 12px;background:${ARTICLE_STYLE_COLORS.neutralSurface};border-left:3px solid ${ARTICLE_STYLE_COLORS.rule};font-size:13px;line-height:1.7;color:${ARTICLE_STYLE_COLORS.text};white-space:pre-wrap;word-break:break-all;text-indent:0;`;
const INLINE_CODE_STYLE = `padding:1px 5px;border:1px solid ${ARTICLE_STYLE_COLORS.rule};border-radius:4px;font-size:14px;color:${ARTICLE_STYLE_COLORS.text};`;
const BLOCKQUOTE_STYLE = `margin:24px 0;padding:0 0 0 14px;border-left:3px solid ${ARTICLE_STYLE_COLORS.rule};color:${ARTICLE_STYLE_COLORS.text};font-size:15px;line-height:1.8;`;
const QUOTE_PARAGRAPH_STYLE = `margin:0;padding:0;text-align:justify;text-indent:0;font-size:15px;line-height:1.8;color:${ARTICLE_STYLE_COLORS.text};letter-spacing:0.24px;word-break:break-word;`;
const REFERENCE_ENTRY_STYLE = 'margin:0 0 10px;';
const REFERENCE_MARKER_STYLE = `margin-right:4px;font-size:13px;line-height:1.55;color:${ARTICLE_STYLE_COLORS.text};font-weight:600;`;
const REFERENCE_TITLE_STYLE = `font-size:13px;line-height:1.55;color:${ARTICLE_STYLE_COLORS.text};font-weight:600;`;
const REFERENCE_URL_STYLE = `font-size:12px;line-height:1.55;color:${ARTICLE_STYLE_COLORS.mutedText};word-break:break-all;`;

function markdownToHtml(markdown: string): string {
  const { articleMarkdown, referenceHeading, referencesMarkdown } = splitReferences(markdown);
  const context = createCitationContext(parseReferenceEntries(referencesMarkdown));
  const articleHtml = renderTokens(Lexer.lex(articleMarkdown), context, true);
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

// A Chinese author indents a paragraph with two U+3000 spaces out of habit, and the paragraph styles
// above already carry text-indent, so the two stack into a four-character indent. Indentation is this
// renderer's decision, so the authored one is dropped here instead of being legislated in a prompt,
// where every future writer would have to be told again and any drift would reach publication.
function stripAuthoredIndent(html: string): string {
  return html.replace(/^[\u3000\u00a0\s]+/, '');
}

function renderTokens(tokens: Token[], context: CitationContext, decorateLeadParagraph = false, paragraphStyle = PARAGRAPH_STYLE): string {
  const leadParagraphIndex = decorateLeadParagraph ? tokens.findIndex((token) => token.type === 'paragraph') : -1;
  return tokens.map((token, index) => renderBlockToken(token, context, index === leadParagraphIndex, paragraphStyle)).join('');
}

function renderBlockToken(token: Token, context: CitationContext, isLeadParagraph = false, paragraphStyle = PARAGRAPH_STYLE): string {
  switch (token.type) {
    case 'space':
    case 'def':
    case 'html':
      return '';
    case 'paragraph':
      return `<p style="${isLeadParagraph ? LEAD_PARAGRAPH_STYLE : paragraphStyle}">${stripAuthoredIndent(renderInlineTokens((token as Tokens.Paragraph).tokens, context))}</p>`;
    case 'heading':
      return renderHeading(token.depth, renderInlineTokens((token as Tokens.Heading).tokens, context));
    case 'code':
      return renderCodeBlock(token.text);
    case 'blockquote':
      return `<blockquote style="${BLOCKQUOTE_STYLE}">${renderTokens((token as Tokens.Blockquote).tokens, context, false, QUOTE_PARAGRAPH_STYLE)}</blockquote>`;
    case 'hr':
      return `<section style="height:1px;margin:30px 0;background:${ARTICLE_STYLE_COLORS.rule};font-size:0;line-height:0;">&nbsp;</section>`;
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

function renderCodeBlock(value: string): string {
  const lines = value.split(/\r?\n/);
  return lines.map((line, index) => {
    const escaped = escapeHtml(line.replaceAll('\t', '    ')) || '&nbsp;';
    const edge = index === 0
      ? 'border-radius:7px 7px 0 0;padding-top:12px;'
      : index === lines.length - 1
        ? 'border-radius:0 0 7px 7px;padding-bottom:12px;margin-bottom:22px;'
        : '';
    return `<p style="${CODE_LINE_STYLE}${edge}"><code>${escaped}</code></p>`;
  }).join('');
}

function renderHeading(depth: number, html: string): string {
  const level = Math.min(Math.max(depth, 1), 6);
  const underline = level === 3 ? `<span style="${HEADING_UNDERLINE_STYLE}">&nbsp;</span>` : '';
  return `<h${level} style="${HEADING_LEVEL_STYLES[level]}">${html}${underline}</h${level}>`;
}

function renderList(token: Tokens.List, context: CitationContext): string {
  const tag = token.ordered ? 'ol' : 'ul';
  const listStyle = token.ordered ? 'decimal' : 'disc';
  const items = token.items.map((item) => `<li style="margin:0 0 7px;padding-left:3px;">${renderTokens(item.tokens, context)}</li>`).join('');
  return `<${tag} style="margin:4px 0 22px;padding-left:1.5em;list-style-type:${listStyle};">${items}</${tag}>`;
}

function renderTable(token: Tokens.Table, context: CitationContext): string {
  const header = token.header.map((cell) => `<th style="${tableCellStyle(true, cell.align)}">${renderInlineTokens(cell.tokens, context)}</th>`).join('');
  const rows = token.rows.map((row, rowIndex) => `<tr>${row.map((cell, cellIndex) => `<td style="${tableCellStyle(false, cell.align, cellIndex, rowIndex === token.rows.length - 1)}">${renderInlineTokens(cell.tokens, context)}</td>`).join('')}</tr>`).join('');
  return `<section style="margin:8px 0 24px;border:1px solid ${ARTICLE_STYLE_COLORS.tableRule};border-radius:11px;overflow-x:auto;"><table style="width:100%;border-collapse:separate;border-spacing:0;font-size:14px;line-height:1.65;text-align:left;"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></section>`;
}

function tableCellStyle(header: boolean, align: 'left' | 'center' | 'right' | null, cellIndex = 0, lastRow = false): string {
  if (header) return `padding:12px 14px;border:0;border-top:3px solid ${ARTICLE_STYLE_COLORS.accentUnderline};text-align:${align ?? 'left'};background:${ARTICLE_STYLE_COLORS.tableHeader};color:${ARTICLE_STYLE_COLORS.tableHeaderText};font-weight:700;`;
  const bottom = lastRow ? '' : `border-bottom:1px solid ${ARTICLE_STYLE_COLORS.tableRule};`;
  const firstColumn = cellIndex === 0 ? `border-right:1px solid ${ARTICLE_STYLE_COLORS.tableRule};font-weight:600;` : '';
  return `padding:12px 14px;${bottom}${firstColumn}text-align:${align ?? 'left'};color:${ARTICLE_STYLE_COLORS.text};`;
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
      return `<strong style="color:${ARTICLE_STYLE_COLORS.text};font-weight:700;text-decoration:underline;">${renderInlineTokens(nestedTokens(token), context)}</strong>`;
    case 'em':
      return `<em style="color:${ARTICLE_STYLE_COLORS.text};">${renderInlineTokens(nestedTokens(token), context)}</em>`;
    case 'del':
      return `<del style="color:${ARTICLE_STYLE_COLORS.mutedText};">${renderInlineTokens(nestedTokens(token), context)}</del>`;
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
    return `<a href="${escapeHtml(url)}" style="color:${ARTICLE_STYLE_COLORS.text};text-decoration:none;border-bottom:1px solid ${ARTICLE_STYLE_COLORS.rule};">${renderInlineTokens(token.tokens, context)}</a>`;
  }
  const plainText = plainInlineTokens(token.tokens).trim();
  const label = !plainText || token.autolink === true || plainText === url ? referenceSourceLabel(url) : plainText;
  citationNumberFor(url, label, context);
  return `<span style="color:${ARTICLE_STYLE_COLORS.text};font-weight:600;">${escapeHtml(label)}</span>`;
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

function htmlToPlainText(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

async function uploadInlineArticleImages(page: Page, article: string, images: GeneratedInlineImage[]): Promise<string> {
  if (findInlineImageReferences(article).length === 0) return article;
  const plan = planInlineImageUploads(article, images);
  const urls = new Map<string, string>();
  await openArticleImagePicker(page);
  const imageDialog = page.locator('.weui-desktop-dialog_img-picker:visible').last();
  try {
    await imageDialog.waitFor({ state: 'visible', timeout: 20_000 });
    const items = imageDialog.locator('.weui-desktop-img-picker__item');
    const knownIdentities = new Set((await settledPickerItemSources(items)).map(thumbnailIdentity));
    const uploadedImages: Array<{ uploadKey: string; identity: string; label: string }> = [];
    for (const upload of plan.uploads) {
      const imagePath = join(tmpdir(), `worklite-wechat-inline-${randomUUID()}.png`);
      await writeFile(imagePath, Buffer.from(upload.b64Json, 'base64'));
      try {
        const identity = await uploadImageToMaterial(page, imageDialog, items, imagePath, upload.uploadKey, knownIdentities);
        uploadedImages.push({ uploadKey: upload.uploadKey, identity, label: upload.uploadKey });
      } finally {
        await rm(imagePath, { force: true }).catch(() => undefined);
      }
    }
    const uploadedUrls = await insertUploadedMaterialsAndReadOriginalUrls(page, imageDialog, items, uploadedImages);
    for (const upload of uploadedImages) {
      const url = uploadedUrls.get(upload.uploadKey);
      if (!url) throw new Error(`The original URL for inline image "${upload.label}" is unavailable.`);
      urls.set(upload.uploadKey, url);
    }
  } finally {
    await closeImagePicker(page);
  }
  return applyInlineImageUrls(article, plan, urls);
}

// The article toolbar's image control is a dropdown, not a dialog opener:
// clicking it only reveals `本地上传 / 从图片库选择 / 微信扫码上传 / AI 配图`.
// 从图片库选择 opens the material picker. The newly uploaded rows are inserted
// together into the focused body editor so its image elements expose the
// canonical material URLs; fillArticle then replaces those temporary nodes with
// the final rendered article content without saving a draft.
const ARTICLE_IMAGE_MENU = 'li#js_editor_insertimage';
const IMAGE_LIBRARY_LABEL = '从图片库选择';

async function uploadImageToMaterial(
  page: Page,
  imageDialog: Locator,
  items: Locator,
  imagePath: string,
  label: string,
  knownIdentities: Set<string>,
): Promise<string> {
  const fileInput = imageDialog.locator('.js_upload_btn_container input[type="file"], input[type="file"]').last();
  await fileInput.setInputFiles(imagePath);

  // An item first appears with only progress text, then the library reloads and
  // paints its thumbnail. Keep waiting until the same identity logic used by
  // the cover flow sees a real, previously unseen material URL.
  const uploadDeadline = Date.now() + 30_000;
  let sources: string[] = [];
  let addedIdentity = '';
  while (Date.now() < uploadDeadline) {
    sources = await pickerItemSources(items);
    const addedSource = sources.find((source) => {
      if (!materialImageCandidate(source)) return false;
      const identity = thumbnailIdentity(source);
      return identity.length >= 32 && !knownIdentities.has(identity);
    });
    if (addedSource) {
      addedIdentity = thumbnailIdentity(addedSource);
      knownIdentities.add(addedIdentity);
      break;
    }
    await delay(500);
  }
  if (!addedIdentity) {
    await page.screenshot({ path: '/tmp/worklite-inline-image-upload-timeout.png', fullPage: true }).catch(() => undefined);
    await writeFile('/tmp/worklite-inline-image-upload-dom.json', JSON.stringify({ label, knownIdentities: [...knownIdentities], after: sources }, null, 2), 'utf8').catch(() => undefined);
    throw new Error(`WeChat did not add the inline image "${label}" to the material library. The picker held ${knownIdentities.size} known items and ${sources.length} visible items after upload.`);
  }
  return addedIdentity;
}

async function openArticleImagePicker(page: Page): Promise<void> {
  const menu = page.locator(ARTICLE_IMAGE_MENU).first();
  if (await menu.isVisible().catch(() => false)) {
    await menu.scrollIntoViewIfNeeded().catch(() => undefined);
    await menu.click({ force: true }).catch(() => undefined);
    // Match the entry by its label as well as its class: the label is what the
    // editor shows a person, so it survives the class churn that broke the
    // previous selectors.
    const entry = menu.locator('.js_img_from_local, .tpl_dropdown_menu_item').filter({ hasText: IMAGE_LIBRARY_LABEL }).first();
    if (await entry.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
      await entry.click({ force: true }).catch(() => undefined);
      if (await imagePickerVisible(page, 20_000)) return;
    }
  }
  // Fall back to the cover's own 从图片库选择 entry: it opens the same picker and
  // uploads to the same library, and dismissing it without a selection leaves
  // the cover untouched. The entry stays `visibility: hidden` until the cover
  // popover opens, so Playwright never counts it as clickable — dispatch the
  // click inside the page instead of waiting for actionability.
  if (await clickCoverImageLibraryEntry(page) && await imagePickerVisible(page, 20_000)) return;
  await page.screenshot({ path: '/tmp/worklite-inline-image-control-timeout.png', fullPage: true }).catch(() => undefined);
  throw new Error('WeChat editor image insert control is unavailable, so inline images could not be uploaded.');
}

async function clickCoverImageLibraryEntry(page: Page): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const label = ${JSON.stringify(IMAGE_LIBRARY_LABEL)};
    const scope = document.querySelector('#js_cover_area') ?? document.querySelector('#js_cover_null') ?? document;
    const entries = [...scope.querySelectorAll('.js_imagedialog'), ...scope.querySelectorAll('a, button, li, span')];
    for (const entry of entries) {
      if (!entry.classList.contains('js_imagedialog') && (entry.textContent ?? '').trim() !== label) continue;
      entry.click();
      return true;
    }
    return false;
  })()`).catch(() => false);
}

// The library paints the images it already holds about a second after the
// dialog appears. Snapshotting before that leaves the baseline empty, and the
// first image the library then paints reads as the one just uploaded — so the
// article would carry some unrelated picture from the account's library.
async function settledPickerItemSources(items: Locator): Promise<string[]> {
  const deadline = Date.now() + 15_000;
  let sources: string[] = [];
  let stable = 0;
  while (Date.now() < deadline && stable < 2) {
    const current = await pickerItemSources(items);
    stable = current.length > 0 && current.length === sources.length ? stable + 1 : 0;
    sources = current;
    if (stable < 2) await delay(400);
  }
  return sources;
}

async function imagePickerVisible(page: Page, timeout: number): Promise<boolean> {
  return page.locator('.weui-desktop-dialog_img-picker:visible').last()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
}

async function closeImagePicker(page: Page): Promise<void> {
  const imageDialog = page.locator('.weui-desktop-dialog_img-picker:visible').last();
  if (!await imageDialog.isVisible().catch(() => false)) return;
  await page.keyboard.press('Escape').catch(() => undefined);
  if (await imagePickerVisible(page, 600)) {
    const closeButton = imageDialog
      .locator('.weui-desktop-dialog__close, .weui-desktop-dialog__close-btn, button[aria-label="Close"], button[aria-label="关闭"]')
      .first();
    if (await closeButton.isVisible().catch(() => false)) await closeButton.click({ force: true }).catch(() => undefined);
    // The picker's own 取消 leaves the upload in the library and selects nothing.
    const cancelButton = imageDialog.locator('button').filter({ hasText: /^(取消|Cancel)$/ }).first();
    if (await cancelButton.isVisible().catch(() => false)) await cancelButton.click({ force: true }).catch(() => undefined);
  }
  if (await imagePickerVisible(page, 1_500)) throw new Error('WeChat image picker stayed open after uploading an inline image.');
}

async function pickerItemSources(items: Locator): Promise<string[]> {
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

// A picker URL establishes that upload finished, but may be a thumbnail. The
// original material URL is read after the editor inserts the selected image.
function materialImageCandidate(source: string): string | null {
  const value = source.match(/url\(["']?(.*?)["']?\)/)?.[1] ?? source;
  return /^https?:\/\//.test(value) && isUploadedMaterialReference(value) ? value : null;
}

function materialImageUrl(source: string, label: string): string {
  const value = materialImageCandidate(source);
  if (!value) throw new Error(`WeChat returned an unusable material URL for inline image "${label}": ${thumbnailIdentity(source) || 'empty'}.`);
  if (isThumbnailMaterialUrl(value)) throw new Error(`WeChat returned a thumbnail URL for inline image "${label}" instead of the editor's original image URL.`);
  return value;
}

function isThumbnailMaterialUrl(value: string): boolean {
  try {
    return /\/300\/?$/.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

async function insertUploadedMaterialsAndReadOriginalUrls(
  page: Page,
  imageDialog: Locator,
  items: Locator,
  uploads: Array<{ uploadKey: string; identity: string; label: string }>,
): Promise<Map<string, string>> {
  const bodyEditor = page.locator('#ueditor_0');
  await bodyEditor.waitFor({ state: 'visible', timeout: 20_000 });
  const imageSelector = 'img[data-src], img[data-imgfileid]';
  const previousImageCount = await bodyEditor.locator(imageSelector).count();
  // An existing draft already holds images, and the editor inserts at the
  // cursor, so new images are told apart by material id, not by position.
  const previousIdentities = new Set((await bodyEditor.locator(imageSelector).evaluateAll((images) => images.map((image) => image.getAttribute('data-src') || image.getAttribute('src') || '')))
    .filter(Boolean)
    .map(thumbnailIdentity));
  const sources = await pickerItemSources(items);
  const uploadedIndices = uploads.map((upload) => sources.findIndex((source) => thumbnailIdentity(source) === upload.identity));
  if (uploadedIndices.some((index) => index < 0)) throw new Error('A newly uploaded inline image disappeared from the material picker before insertion.');

  // Uploading selects new rows automatically. Clear unrelated rows and make
  // sure every newly uploaded image is selected before the single insertion.
  const selectedIndices = await imageDialog.locator('.weui-desktop-img-picker__item.selected').evaluateAll((selectedItems) => {
    const dialog = selectedItems[0]?.closest('.weui-desktop-dialog_img-picker');
    const allItems = Array.from(dialog?.querySelectorAll('.weui-desktop-img-picker__item') ?? []);
    return selectedItems.map((item) => allItems.indexOf(item));
  });
  for (const index of selectedIndices) {
    if (index >= 0 && !uploadedIndices.includes(index)) await items.nth(index).click({ force: true });
  }
  for (const index of uploadedIndices) {
    if (!await items.nth(index).evaluate((element) => element.classList.contains('selected'))) {
      await items.nth(index).click({ force: true });
    }
  }

  const confirmButton = imageDialog.locator('button:visible').filter({ hasText: '确定' }).last();
  await confirmButton.waitFor({ state: 'visible', timeout: 10_000 });
  const confirmHandle = await confirmButton.elementHandle();
  if (!confirmHandle) throw new Error('WeChat did not expose article image insertion for the uploaded materials.');
  await page.waitForFunction(
    (button) => !button.hasAttribute('disabled') && !button.classList.contains('weui-desktop-btn_disabled'),
    confirmHandle,
    { timeout: 15_000 },
  );
  await confirmButton.click();
  await imageDialog.waitFor({ state: 'hidden', timeout: 20_000 });
  const expectedImageCount = previousImageCount + uploads.length;
  const insertionDeadline = Date.now() + 20_000;
  let currentImageCount = await bodyEditor.locator(imageSelector).count();
  while (currentImageCount < expectedImageCount && Date.now() < insertionDeadline) {
    await delay(300);
    currentImageCount = await bodyEditor.locator(imageSelector).count();
  }
  if (currentImageCount < expectedImageCount) throw new Error('WeChat did not insert every selected image into the article body.');

  const insertedImages = await bodyEditor.locator(imageSelector).evaluateAll((images) => images.map((image) => ({
    src: image.getAttribute('src'),
    dataSrc: image.getAttribute('data-src'),
    dataOriginal: image.getAttribute('data-original'),
    dataUrl: image.getAttribute('data-url'),
  })));
  const uploadedUrls = new Map<string, string>();
  for (const image of insertedImages) {
    const originalUrl = [image.dataSrc, image.src, image.dataOriginal, image.dataUrl]
      .find((candidate) => Boolean(candidate && materialImageCandidate(candidate) && !isThumbnailMaterialUrl(candidate)));
    const anyUrl = originalUrl ?? [image.dataSrc, image.src].find(Boolean) ?? '';
    if (previousIdentities.has(thumbnailIdentity(anyUrl))) continue;
    if (!originalUrl) throw new Error('WeChat did not insert an original material URL into the article body.');
    const identity = thumbnailIdentity(originalUrl);
    const upload = uploads.find((candidate) => candidate.identity === identity);
    if (!upload) throw new Error('An inserted article image did not match a newly uploaded material.');
    if (uploadedUrls.has(upload.uploadKey)) throw new Error(`WeChat inserted inline image "${upload.label}" more than once.`);
    uploadedUrls.set(upload.uploadKey, materialImageUrl(originalUrl, upload.label));
  }
  if (uploadedUrls.size !== uploads.length) throw new Error('WeChat did not insert every newly uploaded material into the article body.');
  return uploadedUrls;
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
    // Same upload placeholder as the inline flow: matching it here would click
    // an item that the library's reload then replaces, applying whichever
    // material lands on that index.
    addedIndex = after.findIndex((identity) => {
      if (!materialImageCandidate(identity)) return false;
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
  return pickerItemSources(items);
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
