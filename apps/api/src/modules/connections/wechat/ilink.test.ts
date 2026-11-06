// @vitest-environment node
import { createDecipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ILinkApiError, MESSAGE_ITEM_IMAGE, MESSAGE_TYPE_BOT, MESSAGE_STATE_FINISH, aesEcbPaddedSize, fetchTypingTicket, getUpdates, mediaLabel, parseILinkJson, parseInboundMessage, pollQrCodeStatus, sendFileMessage, sendImageMessage, sendTextMessage, sendTyping, uploadFileToCdn, uploadImageToCdn, type FetchLike } from './ilink';

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
    const fetchImpl: FetchLike = async (_input, init) => { captured = typeof init?.body === 'string' ? init.body : ''; return { ok: true, status: 200, text: async () => '{"ret":0,"message_id":"12345678901234567890"}' }; };
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
    const fetchImpl: FetchLike = async (_input, init) => { captured = typeof init?.body === 'string' ? init.body : ''; return { ok: true, status: 200, text: async () => '{"ret":0}' }; };
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

describe('image outbound', () => {
  const image = Buffer.from('fake-png-bytes-for-upload');

  function imageFetch(captured: Array<{ url: string; body: string; ciphertext?: Buffer }>): FetchLike {
    return async (input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      captured.push({ url: input, body, ...(init?.body instanceof Uint8Array ? { ciphertext: Buffer.from(init.body) } : {}) });
      if (input.endsWith('/ilink/bot/getuploadurl')) {
        return { ok: true, status: 200, text: async () => '{"ret":0,"upload_full_url":"https://cdn.example/upload?sig=1"}' };
      }
      if (input === 'https://cdn.example/upload?sig=1') {
        return { ok: true, status: 200, text: async () => '', headers: { get: (name) => name === 'x-encrypted-param' ? 'download-param-1' : null } };
      }
      return { ok: true, status: 200, text: async () => '{"ret":0,"message_id":"img-1"}' };
    };
  }

  it('negotiates an upload URL, posts AES-128-ECB ciphertext and sends an image_item', async () => {
    const captured: Array<{ url: string; body: string; ciphertext?: Buffer }> = [];
    const fetchImpl = imageFetch(captured);
    const uploaded = await uploadImageToCdn(fetchImpl, { baseUrl: 'https://ilink.example', token: 'tok', toUserId: 'user-a', image });

    expect(uploaded.downloadEncryptedQueryParam).toBe('download-param-1');
    expect(uploaded.fileSize).toBe(image.length);
    expect(uploaded.fileSizeCiphertext).toBe(aesEcbPaddedSize(image.length));
    const uploadRequest = JSON.parse(captured[0].body) as Record<string, unknown>;
    expect(uploadRequest.media_type).toBe(1);
    expect(uploadRequest.aeskey).toBe(uploaded.aeskey);
    expect(uploadRequest.rawfilemd5).toMatch(/^[0-9a-f]{32}$/);

    const ciphertext = captured[1].ciphertext!;
    expect(ciphertext.length).toBe(uploaded.fileSizeCiphertext);
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(uploaded.aeskey, 'hex'), null);
    expect(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString()).toBe(image.toString());

    const sent = await sendImageMessage(fetchImpl, {
      baseUrl: 'https://ilink.example', token: 'tok', toUserId: 'user-a',
      image: uploaded, contextToken: 'ctx-1', clientId: 'client-img-1',
    });
    expect(sent.messageId).toBe('img-1');
    const sendBody = JSON.parse(captured.at(-1)!.body) as { msg: { context_token?: string; client_id?: string; item_list: Array<{ type?: number; image_item?: { media?: Record<string, unknown>; mid_size?: number } }> } };
    expect(sendBody.msg.context_token).toBe('ctx-1');
    expect(sendBody.msg.client_id).toBe('client-img-1');
    expect(sendBody.msg.item_list[0]).toMatchObject({
      type: MESSAGE_ITEM_IMAGE,
      image_item: { media: { encrypt_query_param: 'download-param-1', encrypt_type: 1 }, mid_size: uploaded.fileSizeCiphertext },
    });
    expect(sendBody.msg.item_list[0].image_item?.media?.aes_key).toBe(Buffer.from(uploaded.aeskey, 'utf8').toString('base64'));
  });

  it('fails when the platform rejects the upload request', async () => {
    const failure = await uploadImageToCdn(okFetch('{"ret":-2,"errmsg":"invalid session"}'), { baseUrl: 'https://ilink.example', token: 'tok', toUserId: 'user-a', image }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ILinkApiError);
    expect((failure as ILinkApiError).ret).toBe(-2);
  });

  it('aborts on a CDN client error instead of retrying', async () => {
    let uploads = 0;
    const fetchImpl: FetchLike = async (input) => {
      if (input.endsWith('/ilink/bot/getuploadurl')) {
        return { ok: true, status: 200, text: async () => '{"ret":0,"upload_param":"param-1"}' };
      }
      uploads += 1;
      return { ok: false, status: 400, text: async () => '', headers: { get: (name) => name === 'x-error-message' ? 'bad signature' : null } };
    };
    const failure = await uploadImageToCdn(fetchImpl, { baseUrl: 'https://ilink.example', token: 'tok', toUserId: 'user-a', image }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ILinkApiError);
    expect((failure as ILinkApiError).httpStatus).toBe(400);
    expect(uploads).toBe(1);
  });
});

describe('fetchTypingTicket', () => {
  it('returns the typing ticket from a successful getconfig response', async () => {
    const ticket = await fetchTypingTicket(okFetch('{"ret":0,"typing_ticket":"ticket-abc"}'), { baseUrl: 'https://ilink.example', token: 'tok', userId: 'user-a' });
    expect(ticket).toBe('ticket-abc');
  });

  it('fails on a platform rejection', async () => {
    const failure = await fetchTypingTicket(okFetch('{"ret":-2,"errmsg":"invalid session"}'), { baseUrl: 'https://ilink.example', token: 'tok', userId: 'user-a' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ILinkApiError);
    expect((failure as ILinkApiError).ret).toBe(-2);
  });
});

describe('sendTyping', () => {
  it('posts the typing status with the given ticket', async () => {
    let captured = '';
    const fetchImpl: FetchLike = async (_input, init) => { captured = typeof init?.body === 'string' ? init.body : ''; return { ok: true, status: 200, text: async () => '{}' }; };
    await sendTyping(fetchImpl, { baseUrl: 'https://ilink.example', token: 'tok', userId: 'user-a', typingTicket: 'ticket-abc' });
    const body = JSON.parse(captured) as Record<string, unknown>;
    expect(body.ilink_user_id).toBe('user-a');
    expect(body.typing_ticket).toBe('ticket-abc');
    expect(body.status).toBe(1);
  });

  it('posts the cancel status when cancel is requested', async () => {
    let captured = '';
    const fetchImpl: FetchLike = async (_input, init) => { captured = typeof init?.body === 'string' ? init.body : ''; return { ok: true, status: 200, text: async () => '{}' }; };
    await sendTyping(fetchImpl, { baseUrl: 'https://ilink.example', token: 'tok', userId: 'user-a', typingTicket: 'ticket-abc', cancel: true });
    const body = JSON.parse(captured) as Record<string, unknown>;
    expect(body.status).toBe(2);
  });
});

describe('file outbound protocol', () => {
  const options = { baseUrl: 'https://ilink.example', token: 'tok', toUserId: 'user-a' };

  it('uploads encrypted FILE bytes and preserves the Unicode basename and plaintext length', async () => {
    const content = Buffer.from('pdf/zip/office/unknown bytes\0');
    let uploadRequest: Record<string, unknown> = {};
    let sendRequest: Record<string, unknown> = {};
    let uploadedBytes = Buffer.alloc(0);
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.endsWith('/getuploadurl')) {
        uploadRequest = JSON.parse(init!.body as string);
        expect(init?.headers?.Authorization).toBe('Bearer tok');
        return { ok: true, status: 200, text: async () => '{"upload_param":"a+b"}' };
      }
      if (url.startsWith('https://novac2c.cdn.weixin.qq.com/c2c/upload?')) {
        expect(url).toContain('encrypted_query_param=a%2Bb');
        uploadedBytes = Buffer.from(init!.body as Uint8Array);
        return { ok: true, status: 200, text: async () => '', headers: { get: () => 'download' } };
      }
      sendRequest = JSON.parse(init!.body as string);
      return { ok: true, status: 200, text: async () => '{"ret":0,"message_id":"file-1"}' };
    };
    const uploaded = await uploadFileToCdn(fetchImpl, { ...options, content });
    expect(uploadRequest).toMatchObject({ media_type: 3, to_user_id: 'user-a', rawsize: content.length, filesize: aesEcbPaddedSize(content.length), no_need_thumb: true });
    expect(uploadRequest.rawfilemd5).toBe(createHash('md5').update(content).digest('hex'));
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(uploaded.aeskey, 'hex'), null);
    expect(Buffer.concat([decipher.update(uploadedBytes), decipher.final()])).toEqual(content);
    expect(await sendFileMessage(fetchImpl, { ...options, file: uploaded, fileName: '报告 2026.pdf', contextToken: 'ctx-file', clientId: 'stable-id' })).toEqual({ messageId: 'file-1' });
    expect(sendRequest.msg).toEqual({ from_user_id: '', to_user_id: 'user-a', client_id: 'stable-id', message_type: 2, message_state: 2, context_token: 'ctx-file', item_list: [{ type: 4, file_item: {
      file_name: '报告 2026.pdf', len: String(content.length), media: { encrypt_query_param: 'download', aes_key: Buffer.from(uploaded.aeskey).toString('base64'), encrypt_type: 1 },
    } }] });
  });

  it('retries a missing CDN download parameter but never sends incomplete media', async () => {
    let uploads = 0;
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith('/getuploadurl')) return { ok: true, status: 200, text: async () => '{"upload_full_url":"https://cdn.example/file"}' };
      uploads++;
      return { ok: true, status: 200, text: async () => '', headers: { get: () => null } };
    };
    await expect(uploadFileToCdn(fetchImpl, { ...options, content: Buffer.from('file') })).rejects.toThrow('download parameter');
    expect(uploads).toBe(3);
  });

  it('rejects missing upload URLs and business errcodes', async () => {
    await expect(uploadFileToCdn(okFetch('{"ret":0}'), { ...options, content: Buffer.from('file') })).rejects.toThrow('upload URL');
    await expect(uploadFileToCdn(okFetch('{"ret":0,"errcode":-14}'), { ...options, content: Buffer.from('file') })).rejects.toMatchObject({ errcode: -14 });
    const file = { filekey: 'key', downloadEncryptedQueryParam: 'download', aeskey: '0'.repeat(32), fileSize: 1, fileSizeCiphertext: 16 };
    await expect(sendFileMessage(okFetch('{"ret":0,"errcode":-14}'), { ...options, file, fileName: 'a.zip', contextToken: 'ctx', clientId: 'id' })).rejects.toMatchObject({ errcode: -14 });
  });
});
