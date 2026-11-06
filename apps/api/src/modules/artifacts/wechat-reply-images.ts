import { BadRequestException, NotFoundException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { inspectLocalImage, MAX_LOCAL_IMAGE_BYTES } from './local-image';

export type WechatReplyImage = { kind: 'artifact' | 'attachment'; id: string };
export type WechatReplyPart = { kind: 'text'; text: string } | WechatReplyImage;

/** Keep every image occurrence in place, including links and bare content URLs. */
export function splitWechatReplyImages(markdown: string): WechatReplyPart[] {
  const route = String.raw`(?:https?:\/\/[^\s/<>()[\]]+)?\/api\/(?:artifacts\/art_[A-Za-z0-9-]+\/content|chat\/attachments\/att_[A-Za-z0-9-]+)(?:[?#][^\s<>()]*)?`;
  const references = new RegExp(String.raw`!?\[[^\]\n]*\]\(\s*<?(${route})>?(?:\s+"[^"\n]*")?\s*\)|<?(${route})>?`, 'g');
  const parts: WechatReplyPart[] = [];
  const appendText = (value: string) => {
    const text = value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text) parts.push({ kind: 'text', text });
  };
  let offset = 0;
  for (const match of markdown.matchAll(references)) {
    appendText(markdown.slice(offset, match.index));
    const url = match[1] ?? match[2]!;
    const artifactId = /\/api\/artifacts\/(art_[A-Za-z0-9-]+)\/content/.exec(url)?.[1];
    const attachmentId = /\/api\/chat\/attachments\/(att_[A-Za-z0-9-]+)/.exec(url)?.[1];
    parts.push(artifactId ? { kind: 'artifact', id: artifactId } : { kind: 'attachment', id: attachmentId! });
    offset = match.index! + match[0].length;
  }
  appendText(markdown.slice(offset));
  return parts;
}

/** WorkLite's channel cap, not an assertion about iLink's undocumented server limits. */
export async function inspectWechatImage(image: Buffer): Promise<{ mimeType: string }> {
  if (!image.length) throw new BadRequestException('图片内容为空。');
  if (image.length > MAX_LOCAL_IMAGE_BYTES) throw new PayloadTooLargeException('图片超过当前渠道的 10 MB 发送上限。');
  // Validate the bytes and decoded dimensions, rather than trusting stored MIME metadata.
  return inspectLocalImage(image);
}

export function wechatImageFailureText(error: unknown): string {
  if (error instanceof NotFoundException || (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
    return '[图片已过期或不存在，请在 WorkLite 查看]';
  }
  if (error instanceof PayloadTooLargeException) return '[图片超过当前渠道的 10 MB 发送上限，请在 WorkLite 查看]';
  if (error instanceof UnsupportedMediaTypeException || error instanceof BadRequestException) return '[图片格式或尺寸无效，请在 WorkLite 查看]';
  return '[图片发送失败，请在 WorkLite 查看或稍后重试]';
}
