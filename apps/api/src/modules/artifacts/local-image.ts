import { BadRequestException, UnsupportedMediaTypeException } from '@nestjs/common';
import { loadImage } from '@napi-rs/canvas';
import { readLocalFile } from './local-file';

export const MAX_LOCAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_LOCAL_IMAGE_BATCH_BYTES = 40 * 1024 * 1024;
export const MAX_LOCAL_IMAGES = 8;
export type ImageExtension = 'png' | 'jpg' | 'gif' | 'webp';
const invalidImage = () => new UnsupportedMediaTypeException('仅支持有效的 PNG、JPEG、GIF 或 WebP 图片。');

export function readLocalImage(path: string): Promise<Buffer> {
  return readLocalFile(path, MAX_LOCAL_IMAGE_BYTES, '图片');
}

/** Detect bytes, bound decoded dimensions before allocation, then verify with the image decoder. */
export async function inspectLocalImage(body: Buffer): Promise<{ extension: ImageExtension; mimeType: string; width: number; height: number }> {
  let extension: ImageExtension;
  let width = 0;
  let height = 0;
  if (body.length >= 33 && body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && body.toString('ascii', 12, 16) === 'IHDR') {
    extension = 'png'; width = body.readUInt32BE(16); height = body.readUInt32BE(20);
  } else if (body.length >= 10 && /^GIF8[79]a$/.test(body.toString('ascii', 0, 6))) {
    extension = 'gif'; width = body.readUInt16LE(6); height = body.readUInt16LE(8);
  } else if (body.length >= 4 && body[0] === 0xff && body[1] === 0xd8) {
    extension = 'jpg';
    let offset = 2;
    while (offset + 4 <= body.length) {
      if (body[offset++] !== 0xff) throw invalidImage();
      while (body[offset] === 0xff) offset++;
      const marker = body[offset++]!;
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > body.length) throw invalidImage();
      const size = body.readUInt16BE(offset);
      if (size < 2 || offset + size > body.length) throw invalidImage();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (size < 8) throw invalidImage();
        height = body.readUInt16BE(offset + 3); width = body.readUInt16BE(offset + 5); break;
      }
      offset += size;
    }
  } else if (body.length >= 30 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP' && body.readUInt32LE(4) + 8 === body.length) {
    extension = 'webp';
    const chunk = body.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      width = body.readUIntLE(24, 3) + 1; height = body.readUIntLE(27, 3) + 1;
    } else if (chunk === 'VP8L' && body[20] === 0x2f) {
      const bits = body.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (chunk === 'VP8 ' && body.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      width = body.readUInt16LE(26) & 0x3fff; height = body.readUInt16LE(28) & 0x3fff;
    }
  } else throw invalidImage();
  if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 40_000_000) {
    throw new BadRequestException('图片尺寸无效或超过限制（单边 16384、总像素 4000 万）。');
  }
  try {
    const decoded = await loadImage(body);
    if (decoded.width !== width || decoded.height !== height) throw invalidImage();
  } catch { throw invalidImage(); }
  return { extension, mimeType: extension === 'jpg' ? 'image/jpeg' : `image/${extension}`, width, height };
}
