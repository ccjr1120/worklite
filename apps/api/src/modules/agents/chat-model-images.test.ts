import { describe, expect, it } from 'vitest';
import type { GatewayAgentMessage } from '@worklite/model-gateway';
import { MAX_INLINE_IMAGE_BYTES, MAX_INLINE_IMAGES, inlineUserAttachmentImages, protocolAcceptsImageInput, type ChatAttachmentImageStore } from './chat-model-images';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

type StoredImage = { mimeType?: string; size?: number; projectTaskId?: string | null; body?: Buffer };

function store(images: Record<string, StoredImage>): ChatAttachmentImageStore & { loads: string[] } {
  const loads: string[] = [];
  return {
    loads,
    describe: (id) => {
      const image = images[id];
      if (!image) return null;
      return { mimeType: image.mimeType ?? 'image/png', size: image.size ?? (image.body ?? PNG).length, projectTaskId: image.projectTaskId ?? null };
    },
    load: async (id) => {
      const image = images[id];
      if (!image) return null;
      loads.push(id);
      return { mimeType: image.mimeType ?? 'image/png', body: image.body ?? PNG };
    },
  };
}

function reference(id: string, alt = 'shot.png'): string {
  return `![${alt}](/api/chat/attachments/${id})`;
}

function userMessage(content: string): GatewayAgentMessage {
  return { role: 'user', content };
}

describe('protocolAcceptsImageInput', () => {
  it('accepts every protocol an Agent step can run on and refuses System One', () => {
    expect(protocolAcceptsImageInput('anthropic/messages')).toBe(true);
    expect(protocolAcceptsImageInput('openai/chat')).toBe(true);
    expect(protocolAcceptsImageInput('openai/responses')).toBe(true);
    expect(protocolAcceptsImageInput('codex/responses')).toBe(true);
    expect(protocolAcceptsImageInput('typesafe/systemone')).toBe(false);
  });
});

describe('inlineUserAttachmentImages', () => {
  const protocol = 'anthropic/messages' as const;

  it('replaces a pasted image reference with base64 image content and keeps the prose', async () => {
    const result = await inlineUserAttachmentImages([userMessage(`看这个报错\n\n${reference('att_1')}`)], { protocol, store: store({ att_1: {} }) });
    expect(result.inlined).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.messages).toEqual([{
      role: 'user',
      content: [{ type: 'text', text: '看这个报错' }, { type: 'image', image: PNG.toString('base64'), mediaType: 'image/png' }],
    }]);
  });

  it('sends an image-only message as a single image part', async () => {
    const result = await inlineUserAttachmentImages([userMessage(reference('att_1'))], { protocol, store: store({ att_1: {} }) });
    expect(result.messages).toEqual([{ role: 'user', content: [{ type: 'image', image: PNG.toString('base64'), mediaType: 'image/png' }] }]);
  });

  it('leaves an executor report image as a Markdown reference', async () => {
    const message = userMessage(`任务完成\n\n${reference('att_report')}`);
    const images = store({ att_report: { projectTaskId: 'acall_task' } });
    const result = await inlineUserAttachmentImages([message], { protocol, store: images });
    expect(result).toEqual({ messages: [message], inlined: 0, skipped: [] });
    expect(images.loads).toEqual([]);
  });

  it('leaves a reference whose attachment expired untouched and reports no skip', async () => {
    const message = userMessage(`看这个\n\n${reference('att_gone')}`);
    const result = await inlineUserAttachmentImages([message], { protocol, store: store({}) });
    expect(result).toEqual({ messages: [message], inlined: 0, skipped: [] });
  });

  it('keeps an image above the per-image ceiling as text and names the reason', async () => {
    const message = userMessage(reference('att_big'));
    const result = await inlineUserAttachmentImages([message], { protocol, store: store({ att_big: { size: MAX_INLINE_IMAGE_BYTES + 1 } }) });
    expect(result.messages).toEqual([message]);
    expect(result.skipped).toEqual([{ id: 'att_big', reason: 'too_large' }]);
  });

  it('stops at the per-request image count and keeps the rest as text', async () => {
    const ids = Array.from({ length: MAX_INLINE_IMAGES + 2 }, (_, index) => `att_${index + 1}`);
    const images = store(Object.fromEntries(ids.map((id) => [id, {}])));
    const result = await inlineUserAttachmentImages(ids.map((id) => userMessage(reference(id))), { protocol, store: images });
    expect(result.inlined).toBe(MAX_INLINE_IMAGES);
    expect(result.skipped).toEqual(ids.slice(MAX_INLINE_IMAGES).map((id) => ({ id, reason: 'request_budget' })));
    expect(result.messages.filter((message) => typeof message.content === 'string')).toHaveLength(2);
  });

  it('reads a repeated attachment once and shows it wherever the user referenced it', async () => {
    const images = store({ att_1: {} });
    const result = await inlineUserAttachmentImages([userMessage(reference('att_1')), userMessage(`再看一次 ${reference('att_1')}`)], { protocol, store: images });
    expect(images.loads).toEqual(['att_1']);
    expect(result.inlined).toBe(1);
    const image = { type: 'image', image: PNG.toString('base64'), mediaType: 'image/png' };
    expect(result.messages).toEqual([
      { role: 'user', content: [image] },
      { role: 'user', content: [{ type: 'text', text: '再看一次' }, image] },
    ]);
  });

  it('attaches a clarification answer image as a user message after the ask_user result', async () => {
    const messages: GatewayAgentMessage[] = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc_1', toolName: 'ask_user', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc_1', toolName: 'ask_user', output: { type: 'text', value: `就是这个按钮\n\n${reference('att_1')}` } }] },
    ];
    const result = await inlineUserAttachmentImages(messages, { protocol, store: store({ att_1: {} }) });
    expect(result.inlined).toBe(1);
    expect(result.messages).toEqual([
      messages[0],
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc_1', toolName: 'ask_user', output: { type: 'text', value: '就是这个按钮' } }] },
      { role: 'user', content: [{ type: 'text', text: '以下是用户随上一条回答附带的图片。' }, { type: 'image', image: PNG.toString('base64'), mediaType: 'image/png' }] },
    ]);
  });

  it('ignores images in any tool result other than a clarification answer', async () => {
    const messages: GatewayAgentMessage[] = [
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc_1', toolName: 'project_task', output: { type: 'text', value: reference('att_1') } }] },
    ];
    const images = store({ att_1: {} });
    expect(await inlineUserAttachmentImages(messages, { protocol, store: images })).toEqual({ messages, inlined: 0, skipped: [] });
    expect(images.loads).toEqual([]);
  });

  it('keeps every image as text on a protocol without image input and reports the reason', async () => {
    const message = userMessage(reference('att_1'));
    const images = store({ att_1: {} });
    const result = await inlineUserAttachmentImages([message], { protocol: 'typesafe/systemone', store: images });
    expect(result.messages).toEqual([message]);
    expect(result.skipped).toEqual([{ id: 'att_1', reason: 'protocol' }]);
    expect(images.loads).toEqual([]);
  });
});
