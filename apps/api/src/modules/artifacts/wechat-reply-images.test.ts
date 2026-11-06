import { createCanvas } from '@napi-rs/canvas';
import { BadRequestException, NotFoundException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { inspectWechatImage, splitWechatReplyImages, wechatImageFailureText } from './wechat-reply-images';

describe('WeChat reply images', () => {
  it('preserves interleaved prose and every artifact/attachment occurrence', () => {
    expect(splitWechatReplyImages('前文\n![第一张](/api/artifacts/art_first/content)\n中间\n![附件](/api/chat/attachments/att_second)\n![再次](/api/artifacts/art_first/content)\n后文')).toEqual([
      { kind: 'text', text: '前文' }, { kind: 'artifact', id: 'art_first' },
      { kind: 'text', text: '中间' }, { kind: 'attachment', id: 'att_second' },
      { kind: 'artifact', id: 'art_first' }, { kind: 'text', text: '后文' },
    ]);
  });

  it('consumes absolute URLs, titled Markdown, ordinary links and bare references', () => {
    const parts = splitWechatReplyImages('![图](<https://worklite.example/api/artifacts/art_one/content?download=1> "截图")\n[图](/api/chat/attachments/att_two)\n<https://worklite.example/api/artifacts/art_three/content>\n/api/chat/attachments/att_four');
    expect(parts).toEqual([
      { kind: 'artifact', id: 'art_one' }, { kind: 'attachment', id: 'att_two' },
      { kind: 'artifact', id: 'art_three' }, { kind: 'attachment', id: 'att_four' },
    ]);
    expect(splitWechatReplyImages('普通回复 ![外部图](https://example.com/photo.png)')).toEqual([{ kind: 'text', text: '普通回复 ![外部图](https://example.com/photo.png)' }]);
    expect(splitWechatReplyImages('')).toEqual([]);
  });

  it('validates supported formats from actual bytes', async () => {
    const canvas = createCanvas(2, 2);
    for (const [type, body] of [
      ['image/png', canvas.toBuffer('image/png')],
      ['image/jpeg', canvas.toBuffer('image/jpeg')],
      ['image/webp', canvas.toBuffer('image/webp')],
    ] as const) {
      await expect(inspectWechatImage(body)).resolves.toMatchObject({ mimeType: type });
    }
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    await expect(inspectWechatImage(gif)).resolves.toMatchObject({ mimeType: 'image/gif' });
    await expect(inspectWechatImage(Buffer.from('<svg/>'))).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    await expect(inspectWechatImage(Buffer.alloc(0))).rejects.toBeInstanceOf(BadRequestException);
    await expect(inspectWechatImage(Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toBeInstanceOf(PayloadTooLargeException);
    const oversized = createCanvas(2, 2).toBuffer('image/png');
    oversized.writeUInt32BE(16385, 16);
    await expect(inspectWechatImage(oversized)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('never exposes internal URLs, local paths or transport error details in a fallback', () => {
    for (const error of [new NotFoundException(), new PayloadTooLargeException(), new UnsupportedMediaTypeException(), new Error('/private/secret.png /api/artifacts/art_secret/content')]) {
      const text = wechatImageFailureText(error);
      expect(text).toContain('WorkLite');
      expect(text).not.toMatch(/\/api\/|\/private\//);
    }
  });
});
