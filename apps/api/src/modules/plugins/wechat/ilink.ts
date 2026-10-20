import { randomInt } from 'node:crypto';

// iLink bot protocol client for the WeChat conversation channel. The protocol shape follows
// Tencent's MIT-licensed @tencent-weixin/openclaw-weixin plugin (v2.4.10), reimplemented here
// as pure functions with an injectable fetch so tests and mocks sit at the network boundary.
// Only the private-chat text subset WorkLite's first version needs is implemented.

export const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const ILINK_BOT_TYPE = '3';
export const ILINK_STALE_TOKEN_ERRCODE = -14;
export const ILINK_APP_ID = 'bot';
// Client version is informational protocol metadata; WorkLite reports its own adapter version.
const CLIENT_VERSION = (1 << 16) | (0 << 8) | 0;
const CHANNEL_VERSION = '1.0.0';
const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const QR_POLL_TIMEOUT_MS = 40_000;

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

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
      item_list: [{ type: 1, text_item: { text: options.text } }],
      // The reply context issued with the inbound message must be echoed on every send.
      ...(options.contextToken ? { context_token: options.contextToken } : {}),
    },
    base_info: baseInfo(),
  }, options.token, API_TIMEOUT_MS);
  const ret = asNumber(parsed.ret);
  if (ret !== 0) throw new ILinkApiError(asString(parsed.errmsg) || `iLink sendmessage failed (ret=${ret}).`, ret, asNumber(parsed.errcode));
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
