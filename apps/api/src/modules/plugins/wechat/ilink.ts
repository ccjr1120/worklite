import { createCipheriv, createHash, randomBytes, randomInt } from 'node:crypto';

// iLink bot protocol client for the WeChat conversation channel. The protocol shape follows
// Tencent's MIT-licensed @tencent-weixin/openclaw-weixin plugin (v2.4.10), reimplemented here
// as pure functions with an injectable fetch so tests and mocks sit at the network boundary.
// Text and image outbound are implemented; other media stays inbound-labelled only.

export const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
// Media uploads are independent of the regional bot API host: getuploadurl returns a full URL,
// and this base only serves as the documented fallback when it does not.
export const ILINK_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const ILINK_BOT_TYPE = '3';
export const ILINK_STALE_TOKEN_ERRCODE = -14;
export const ILINK_APP_ID = 'bot';
// Client version is informational protocol metadata; WorkLite reports its own adapter version.
const CLIENT_VERSION = (1 << 16) | (0 << 8) | 0;
const CHANNEL_VERSION = '1.0.0';
const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const CDN_UPLOAD_TIMEOUT_MS = 60_000;
const QR_POLL_TIMEOUT_MS = 40_000;
const CDN_UPLOAD_RETRIES = 3;

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; headers?: { get: (name: string) => string | null } }>;

export class ILinkApiError extends Error {
  constructor(message: string, readonly ret: number | null = null, readonly errcode: number | null = null, readonly httpStatus: number | null = null) {
    super(message);
    this.name = 'ILinkApiError';
  }
}

export type ILinkQrCode = { qrcode: string; qrCodeUrl: string };

export type ILinkQrStatus =
  | { status: 'wait' }
  | { status: 'scaned' }
  | { status: 'confirmed'; botToken: string; botId: string; baseUrl: string; userId: string }
  | { status: 'expired' }
  | { status: 'scaned_but_redirect'; redirectHost: string }
  | { status: 'need_verifycode' }
  | { status: 'verify_code_blocked' }
  | { status: 'binded_redirect' };

export type ILinkRawMessage = Record<string, unknown>;

export type ILinkInboundMessage = {
  messageId: string;
  fromUserId: string;
  toUserId: string;
  text: string;
  mediaKind: 'image' | 'voice' | 'file' | 'video' | null;
  contextToken: string;
  groupId: string;
  createTimeMs: number;
};

export type ILinkUpdates = {
  msgs: ILinkRawMessage[];
  getUpdatesBuf: string;
  longpollingTimeoutMs: number | null;
};

export const MESSAGE_TYPE_USER = 1;
export const MESSAGE_TYPE_BOT = 2;
export const MESSAGE_STATE_FINISH = 2;
export const MESSAGE_ITEM_TEXT = 1;
export const MESSAGE_ITEM_IMAGE = 2;
// proto: UploadMediaType
const UPLOAD_MEDIA_IMAGE = 1;
// sendtyping status: 1 sets the typing indicator, 2 cancels it.
const TYPING_STATUS_TYPING = 1;
const TYPING_STATUS_CANCEL = 2;

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const asString = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
const asNumber = (value: unknown): number => typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : 0;

// iLink carries message_id/msg_id/svr_id as uint64. Quote large integer literals for those
// keys before JSON.parse so identifiers survive losslessly.
const UINT64_KEY_PATTERN = /("(?:message_id|msg_id|svr_id)"\s*:\s*)(\d{15,})/g;
export function parseILinkJson(text: string): unknown {
  return JSON.parse(text.replace(UINT64_KEY_PATTERN, '$1"$2"'));
}

function headers(token?: string): Record<string, string> {
  const result: Record<string, string> = {
    'Content-Type': 'application/json',
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(CLIENT_VERSION),
    'AuthorizationType': 'ilink_bot_token',
    // X-WECHAT-UIN: random uint32 as decimal text, base64-encoded.
    'X-WECHAT-UIN': Buffer.from(String(randomInt(0, 0xffffffff)), 'utf8').toString('base64'),
  };
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

const baseInfo = () => ({ channel_version: CHANNEL_VERSION, bot_agent: 'worklite' });

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function post(fetchImpl: FetchLike, url: string, body: unknown, token: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { method: 'POST', headers: headers(token), body: JSON.stringify(body), signal: combinedSignal(signal, timeoutMs) });
  const text = await response.text();
  const parsed = asRecord(parseILinkJson(text || '{}'));
  if (!response.ok) throw new ILinkApiError(`iLink request failed with HTTP ${response.status}.`, asNumber(parsed.ret) || null, asNumber(parsed.errcode) || null, response.status);
  return parsed;
}

export async function fetchBotQrCode(fetchImpl: FetchLike, baseUrl: string = ILINK_DEFAULT_BASE_URL): Promise<ILinkQrCode> {
  const parsed = await post(fetchImpl, `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${ILINK_BOT_TYPE}`, { local_token_list: [] }, undefined, API_TIMEOUT_MS);
  const qrcode = asString(parsed.qrcode);
  const qrCodeUrl = asString(parsed.qrcode_img_content);
  if (!qrcode || !qrCodeUrl) throw new ILinkApiError('iLink did not return a login QR code.');
  return { qrcode, qrCodeUrl };
}

export async function pollQrCodeStatus(fetchImpl: FetchLike, qrcode: string, host: string, signal?: AbortSignal): Promise<ILinkQrStatus> {
  const response = await fetchImpl(`${host}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, { method: 'GET', headers: headers(), signal: combinedSignal(signal, QR_POLL_TIMEOUT_MS) });
  const parsed = asRecord(parseILinkJson(await response.text() || '{}'));
  if (!response.ok) throw new ILinkApiError(`iLink QR status failed with HTTP ${response.status}.`, null, null, response.status);
  const status = asString(parsed.status);
  switch (status) {
    case 'confirmed':
      return { status, botToken: asString(parsed.bot_token), botId: asString(parsed.ilink_bot_id), baseUrl: asString(parsed.baseurl) || ILINK_DEFAULT_BASE_URL, userId: asString(parsed.ilink_user_id) };
    case 'scaned_but_redirect':
      return { status, redirectHost: asString(parsed.redirect_host) };
    case 'scaned': case 'expired': case 'need_verifycode': case 'verify_code_blocked': case 'binded_redirect':
      return { status } as ILinkQrStatus;
    default:
      return { status: 'wait' };
  }
}

export async function getUpdates(fetchImpl: FetchLike, options: { baseUrl: string; token: string; syncBuf: string; timeoutMs?: number; signal?: AbortSignal }): Promise<ILinkUpdates> {
  const parsed = await post(fetchImpl, `${options.baseUrl}/ilink/bot/getupdates`, { get_updates_buf: options.syncBuf, base_info: baseInfo() }, options.token, (options.timeoutMs ?? LONG_POLL_TIMEOUT_MS) + 5_000, options.signal);
  const ret = asNumber(parsed.ret);
  const errcode = asNumber(parsed.errcode);
  if (ret !== 0 || errcode !== 0) throw new ILinkApiError(asString(parsed.errmsg) || `iLink getupdates failed (ret=${ret}, errcode=${errcode}).`, ret, errcode);
  return {
    msgs: Array.isArray(parsed.msgs) ? parsed.msgs.map(asRecord) : [],
    getUpdatesBuf: asString(parsed.get_updates_buf) || options.syncBuf,
    longpollingTimeoutMs: asNumber(parsed.longpolling_timeout_ms) || null,
  };
}

export async function sendTextMessage(fetchImpl: FetchLike, options: { baseUrl: string; token: string; toUserId: string; text: string; contextToken: string; clientId: string }): Promise<{ messageId: string }> {
  const parsed = await post(fetchImpl, `${options.baseUrl}/ilink/bot/sendmessage`, {
    msg: {
      from_user_id: '',
      to_user_id: options.toUserId,
      client_id: options.clientId,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      item_list: [{ type: MESSAGE_ITEM_TEXT, text_item: { text: options.text } }],
      // The reply context issued with the inbound message must be echoed on every send.
      ...(options.contextToken ? { context_token: options.contextToken } : {}),
    },
    base_info: baseInfo(),
  }, options.token, API_TIMEOUT_MS);
  const ret = asNumber(parsed.ret);
  if (ret !== 0) throw new ILinkApiError(asString(parsed.errmsg) || `iLink sendmessage failed (ret=${ret}).`, ret, asNumber(parsed.errcode));
  return { messageId: asString(parsed.message_id) };
}

// Image uploads follow the same three-step flow as the reference client: ask getuploadurl for a
// pre-signed CDN target, POST the AES-128-ECB ciphertext there, then reference the returned
// download parameter in an image_item. The AES key travels hex-encoded to getuploadurl and as a
// base64 string (of that hex text, mirroring the reference client) on the sent image item.
export type ILinkUploadedImage = {
  filekey: string;
  downloadEncryptedQueryParam: string;
  /** Hex-encoded AES-128 key, as accepted by getuploadurl. */
  aeskey: string;
  /** Plaintext byte length. */
  fileSize: number;
  /** AES-128-ECB ciphertext byte length, reported as the image's mid_size. */
  fileSizeCiphertext: number;
};

/** PKCS7 padding always adds a block, so the ciphertext size rounds up from size + 1. */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

// The fallback URL shape used when getuploadurl omits upload_full_url.
export function buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string): string {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

export function imageItem(uploaded: ILinkUploadedImage): Record<string, unknown> {
  return {
    media: {
      encrypt_query_param: uploaded.downloadEncryptedQueryParam,
      aes_key: Buffer.from(uploaded.aeskey, 'utf8').toString('base64'),
      encrypt_type: 1,
    },
    mid_size: uploaded.fileSizeCiphertext,
  };
}

async function fetchUploadUrl(fetchImpl: FetchLike, options: {
  baseUrl: string; token: string; toUserId: string; filekey: string; rawsize: number;
  rawfilemd5: string; filesize: number; aeskey: string;
}): Promise<{ uploadFullUrl: string; uploadParam: string }> {
  const parsed = await post(fetchImpl, `${options.baseUrl}/ilink/bot/getuploadurl`, {
    filekey: options.filekey,
    media_type: UPLOAD_MEDIA_IMAGE,
    to_user_id: options.toUserId,
    rawsize: options.rawsize,
    rawfilemd5: options.rawfilemd5,
    filesize: options.filesize,
    no_need_thumb: true,
    aeskey: options.aeskey,
    base_info: baseInfo(),
  }, options.token, API_TIMEOUT_MS);
  const ret = asNumber(parsed.ret);
  if (ret !== 0) throw new ILinkApiError(asString(parsed.errmsg) || `iLink getuploadurl failed (ret=${ret}).`, ret, asNumber(parsed.errcode));
  return { uploadFullUrl: asString(parsed.upload_full_url).trim(), uploadParam: asString(parsed.upload_param) };
}

// The CDN signals success with 200 plus an x-encrypted-param header; client errors are final,
// while server errors are retried because the pre-signed target stays valid.
async function uploadCiphertext(fetchImpl: FetchLike, url: string, ciphertext: Buffer): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= CDN_UPLOAD_RETRIES; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: ciphertext,
        signal: AbortSignal.timeout(CDN_UPLOAD_TIMEOUT_MS),
      });
      if (response.status >= 400 && response.status < 500) {
        const detail = response.headers?.get('x-error-message') || '';
        throw new ILinkApiError(`iLink CDN rejected the image upload (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`, null, null, response.status);
      }
      if (response.status !== 200) {
        const detail = response.headers?.get('x-error-message') || `HTTP ${response.status}`;
        throw new ILinkApiError(`iLink CDN image upload failed: ${detail}`, null, null, response.status);
      }
      const downloadParam = response.headers?.get('x-encrypted-param');
      if (!downloadParam) throw new ILinkApiError('iLink CDN upload response did not include a download parameter.', null, null, response.status);
      return downloadParam;
    } catch (error) {
      lastError = error;
      if (error instanceof ILinkApiError && error.httpStatus !== null && error.httpStatus < 500) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new ILinkApiError('iLink CDN image upload failed.');
}

export async function uploadImageToCdn(fetchImpl: FetchLike, options: {
  baseUrl: string; token: string; toUserId: string; image: Buffer; cdnBaseUrl?: string;
}): Promise<ILinkUploadedImage> {
  if (!options.image.length) throw new ILinkApiError('Cannot upload an empty image.');
  const rawsize = options.image.length;
  const rawfilemd5 = createHash('md5').update(options.image).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = randomBytes(16).toString('hex');
  const aeskey = randomBytes(16);
  const upload = await fetchUploadUrl(fetchImpl, {
    baseUrl: options.baseUrl, token: options.token, toUserId: options.toUserId,
    filekey, rawsize, rawfilemd5, filesize, aeskey: aeskey.toString('hex'),
  });
  const uploadUrl = upload.uploadFullUrl
    || (upload.uploadParam ? buildCdnUploadUrl(options.cdnBaseUrl ?? ILINK_CDN_BASE_URL, upload.uploadParam, filekey) : '');
  if (!uploadUrl) throw new ILinkApiError('iLink did not return an image upload URL.');
  const ciphertext = encryptAesEcb(options.image, aeskey);
  const downloadEncryptedQueryParam = await uploadCiphertext(fetchImpl, uploadUrl, ciphertext);
  return {
    filekey, downloadEncryptedQueryParam, aeskey: aeskey.toString('hex'),
    fileSize: rawsize, fileSizeCiphertext: ciphertext.length,
  };
}

export async function sendImageMessage(fetchImpl: FetchLike, options: {
  baseUrl: string; token: string; toUserId: string; image: ILinkUploadedImage; contextToken: string; clientId: string;
}): Promise<{ messageId: string }> {
  const parsed = await post(fetchImpl, `${options.baseUrl}/ilink/bot/sendmessage`, {
    msg: {
      from_user_id: '',
      to_user_id: options.toUserId,
      client_id: options.clientId,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      item_list: [{ type: MESSAGE_ITEM_IMAGE, image_item: imageItem(options.image) }],
      ...(options.contextToken ? { context_token: options.contextToken } : {}),
    },
    base_info: baseInfo(),
  }, options.token, API_TIMEOUT_MS);
  const ret = asNumber(parsed.ret);
  if (ret !== 0) throw new ILinkApiError(asString(parsed.errmsg) || `iLink sendmessage (image) failed (ret=${ret}).`, ret, asNumber(parsed.errcode));
  return { messageId: asString(parsed.message_id) };
}

// getconfig issues the per-user typing ticket that sendtyping requires; the reference client
// caches it since it has its own ~24h validity window independent of the bot token.
export async function fetchTypingTicket(fetchImpl: FetchLike, options: { baseUrl: string; token: string; userId: string; contextToken?: string }): Promise<string> {
  const parsed = await post(fetchImpl, `${options.baseUrl}/ilink/bot/getconfig`, { ilink_user_id: options.userId, ...(options.contextToken ? { context_token: options.contextToken } : {}), base_info: baseInfo() }, options.token, API_TIMEOUT_MS);
  if (asNumber(parsed.ret) !== 0) throw new ILinkApiError(asString(parsed.errmsg) || `iLink getconfig failed (ret=${asNumber(parsed.ret)}).`, asNumber(parsed.ret), asNumber(parsed.errcode));
  return asString(parsed.typing_ticket);
}

// sendtyping's response carries no business return code to check; the platform accepts the
// request as fire-and-forget, so callers should not block a reply on this succeeding.
export async function sendTyping(fetchImpl: FetchLike, options: { baseUrl: string; token: string; userId: string; typingTicket: string; cancel?: boolean }): Promise<void> {
  await post(fetchImpl, `${options.baseUrl}/ilink/bot/sendtyping`, { ilink_user_id: options.userId, typing_ticket: options.typingTicket, status: options.cancel ? TYPING_STATUS_CANCEL : TYPING_STATUS_TYPING, base_info: baseInfo() }, options.token, API_TIMEOUT_MS);
}

const MEDIA_LABELS: Record<number, { kind: ILinkInboundMessage['mediaKind']; label: string }> = {
  2: { kind: 'image', label: '[图片]' },
  3: { kind: 'voice', label: '[语音]' },
  4: { kind: 'file', label: '[文件]' },
  5: { kind: 'video', label: '[视频]' },
};

// Normalizes one raw getupdates message into the channel's inbound shape. Returns null for
// messages without any usable identifier or sender.
export function parseInboundMessage(raw: ILinkRawMessage): ILinkInboundMessage | null {
  const items = Array.isArray(raw.item_list) ? raw.item_list.map(asRecord) : [];
  const messageId = asString(raw.message_id) || asString(items.map((item) => item.msg_id).find(Boolean));
  const fromUserId = asString(raw.from_user_id);
  if (!messageId || !fromUserId) return null;
  let text = '';
  let mediaKind: ILinkInboundMessage['mediaKind'] = null;
  for (const item of items) {
    const type = asNumber(item.type);
    if (type === 1) { text = asString(asRecord(item.text_item).text).trim(); continue; }
    if (type === 3) {
      // Voice items may carry a platform transcription; treat it as text when present.
      const transcription = asString(asRecord(item.voice_item).text).trim();
      if (transcription) { text = transcription; continue; }
    }
    if (MEDIA_LABELS[type]) mediaKind ??= MEDIA_LABELS[type].kind;
  }
  return {
    messageId, fromUserId, toUserId: asString(raw.to_user_id), text, mediaKind,
    contextToken: asString(raw.context_token), groupId: asString(raw.group_id),
    createTimeMs: asNumber(raw.create_time_ms),
  };
}

export function mediaLabel(kind: ILinkInboundMessage['mediaKind']): string {
  return kind ? Object.values(MEDIA_LABELS).find((entry) => entry.kind === kind)?.label ?? '[消息]' : '';
}
