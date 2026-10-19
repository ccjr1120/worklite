import { describe, expect, it } from 'vitest';
import { ILinkApiError, MESSAGE_TYPE_BOT, MESSAGE_STATE_FINISH, getUpdates, mediaLabel, parseILinkJson, parseInboundMessage, pollQrCodeStatus, sendTextMessage, type FetchLike } from './ilink';

const okFetch = (body: string): FetchLike => async () => ({ ok: true, status: 200, text: async () => body });

describe('parseILinkJson', () => {
  it('keeps uint64 message identifiers lossless', () => {
    const parsed = parseILinkJson('{"message_id":12345678901234567890,"msg_id":99999999999999999999,"svr_id":42,"text":"hello"}') as Record<string, unknown>;
    expect(parsed.message_id).toBe('12345678901234567890');
    expect(parsed.msg_id).toBe('99999999999999999999');
    expect(parsed.svr_id).toBe(42);
    expect(parsed.text).toBe('hello');
  });
});

describe('parseInboundMessage', () => {
  it('extracts text and context token from a private text message', () => {
    const message = parseInboundMessage({
      message_id: '12345678901234567890',
      from_user_id: 'user-a',
      to_user_id: 'bot-b',
      context_token: 'ctx-1',
      create_time_ms: 1700000000000,
      item_list: [{ type: 1, text_item: { text: '  你好  ' } }],
    });
    expect(message).toEqual({ messageId: '12345678901234567890', fromUserId: 'user-a', toUserId: 'bot-b', text: '你好', mediaKind: null, contextToken: 'ctx-1', groupId: '', createTimeMs: 1700000000000 });
  });

  it('treats a voice transcription as text', () => {
    const message = parseInboundMessage({ message_id: '1', from_user_id: 'user-a', item_list: [{ type: 3, voice_item: { text: '语音转文字' } }] });
    expect(message?.text).toBe('语音转文字');
    expect(message?.mediaKind).toBeNull();
  });

  it('labels unsupported media without text', () => {
    const message = parseInboundMessage({ message_id: '1', from_user_id: 'user-a', item_list: [{ type: 2, image_item: {} }] });
    expect(message?.text).toBe('');
    expect(message?.mediaKind).toBe('image');
    expect(mediaLabel(message!.mediaKind)).toBe('[图片]');
  });

  it('rejects messages without an identifier or sender', () => {
    expect(parseInboundMessage({ from_user_id: 'user-a', item_list: [] })).toBeNull();
    expect(parseInboundMessage({ message_id: '1', item_list: [] })).toBeNull();
  });
});

describe('pollQrCodeStatus', () => {
  it('maps a confirmed status with login credentials', async () => {
    const status = await pollQrCodeStatus(okFetch('{"status":"confirmed","bot_token":"tok","ilink_bot_id":"bot-1","baseurl":"https://ilink.example","ilink_user_id":"user-1"}'), 'qr', 'https://ilinkai.weixin.qq.com');
    expect(status).toEqual({ status: 'confirmed', botToken: 'tok', botId: 'bot-1', baseUrl: 'https://ilink.example', userId: 'user-1' });
  });

  it('maps unknown statuses to wait', async () => {
    expect(await pollQrCodeStatus(okFetch('{"status":"something_new"}'), 'qr', 'https://ilinkai.weixin.qq.com')).toEqual({ status: 'wait' });
  });

  it('surfaces redirect and terminal scan states', async () => {
    expect(await pollQrCodeStatus(okFetch('{"status":"scaned_but_redirect","redirect_host":"https://other.example"}'), 'qr', 'https://ilinkai.weixin.qq.com')).toEqual({ status: 'scaned_but_redirect', redirectHost: 'https://other.example' });
    expect(await pollQrCodeStatus(okFetch('{"status":"expired"}'), 'qr', 'https://ilinkai.weixin.qq.com')).toEqual({ status: 'expired' });
  });
});

describe('getUpdates', () => {
  it('returns messages and the next sync cursor', async () => {
    const result = await getUpdates(okFetch('{"ret":0,"errcode":0,"msgs":[{"message_id":"1"}],"get_updates_buf":"buf-2","longpolling_timeout_ms":30000}'), { baseUrl: 'https://ilink.example', token: 'tok', syncBuf: 'buf-1' });
    expect(result.msgs).toHaveLength(1);
    expect(result.getUpdatesBuf).toBe('buf-2');
    expect(result.longpollingTimeoutMs).toBe(30000);
  });

  it('keeps the previous sync cursor when the platform omits one', async () => {
    const result = await getUpdates(okFetch('{"ret":0,"errcode":0,"msgs":[]}'), { baseUrl: 'https://ilink.example', token: 'tok', syncBuf: 'buf-1' });
    expect(result.getUpdatesBuf).toBe('buf-1');
  });

  it('classifies a stale token failure', async () => {
    const failure = await getUpdates(okFetch('{"ret":-14,"errcode":-14,"errmsg":"session expired"}'), { baseUrl: 'https://ilink.example', token: 'tok', syncBuf: '' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ILinkApiError);
    expect((failure as ILinkApiError).errcode).toBe(-14);
  });
});

describe('sendTextMessage', () => {
  it('echoes the context token and idempotency client id', async () => {
    let captured = '';
    const fetchImpl: FetchLike = async (_input, init) => { captured = init?.body ?? ''; return { ok: true, status: 200, text: async () => '{"ret":0,"message_id":"12345678901234567890"}' }; };
    const result = await sendTextMessage(fetchImpl, { baseUrl: 'https://ilink.example', token: 'tok', toUserId: 'user-a', text: '回复', contextToken: 'ctx-1', clientId: 'client-1' });
    expect(result.messageId).toBe('12345678901234567890');
    const body = JSON.parse(captured) as { msg: Record<string, unknown> };
    expect(body.msg.to_user_id).toBe('user-a');
    expect(body.msg.client_id).toBe('client-1');
    expect(body.msg.context_token).toBe('ctx-1');
    expect(body.msg.message_type).toBe(MESSAGE_TYPE_BOT);
    expect(body.msg.message_state).toBe(MESSAGE_STATE_FINISH);
  });

  it('omits the context token when none was issued', async () => {
    let captured = '';
    const fetchImpl: FetchLike = async (_input, init) => { captured = init?.body ?? ''; return { ok: true, status: 200, text: async () => '{"ret":0}' }; };
    await sendTextMessage(fetchImpl, { baseUrl: 'https://ilink.example', token: 'tok', toUserId: 'user-a', text: '回复', contextToken: '', clientId: 'client-1' });
    const body = JSON.parse(captured) as { msg: Record<string, unknown> };
    expect('context_token' in body.msg).toBe(false);
  });

  it('fails on a platform rejection', async () => {
    const failure = await sendTextMessage(okFetch('{"ret":-2,"errmsg":"invalid session"}'), { baseUrl: 'https://ilink.example', token: 'tok', toUserId: 'user-a', text: '回复', contextToken: '', clientId: 'c' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ILinkApiError);
    expect((failure as ILinkApiError).ret).toBe(-2);
  });
});
