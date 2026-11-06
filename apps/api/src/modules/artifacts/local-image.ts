import { BadRequestException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { loadImage } from '@napi-rs/canvas';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, sep } from 'node:path';

export const MAX_LOCAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_LOCAL_IMAGE_BATCH_BYTES = 40 * 1024 * 1024;
export const MAX_LOCAL_IMAGES = 8;
export type ImageExtension = 'png' | 'jpg' | 'gif' | 'webp';
const invalidImage = () => new UnsupportedMediaTypeException('仅支持有效的 PNG、JPEG、GIF 或 WebP 图片。');

/** Local paths are input only: never include them (including filesystem errors) in a result. */
export async function readLocalImage(path: string): Promise<Buffer> {
  if (!isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).includes('..')) {
    throw new BadRequestException('图片路径必须是无路径穿越的本地绝对路径。');
  }
  try {
    // Reject symlinks in every component. macOS's system /tmp, /var and /etc aliases
    // are canonicalized explicitly so ordinary screenshot paths under /tmp work.
    let current = parse(path).root;
    for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        if (process.platform === 'darwin' && ['/tmp', '/var', '/etc'].includes(current)) current = await realpath(current);
        else throw new Error('symlink');
      }
    }
    const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (await realpath(current) !== current) throw new Error('path changed');
      const before = await handle.stat();
      if (!before.isFile()) throw new Error('not a regular file');
      if (before.size > MAX_LOCAL_IMAGE_BYTES) throw new PayloadTooLargeException('单张图片不能超过 10 MB。');
      // A bounded read also covers files that grow after stat; readFile alone would not.
      const body = Buffer.alloc(Math.min(before.size + 1, MAX_LOCAL_IMAGE_BYTES + 1));
      let length = 0;
      while (length < body.length) {
        const { bytesRead } = await handle.read(body, length, body.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      const entry = await lstat(current);
      if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || entry.isSymbolicLink() || entry.dev !== before.dev || entry.ino !== before.ino || await realpath(current) !== current) throw new Error('file changed');
      if (!length) throw new BadRequestException('图片内容为空。');
      return body.subarray(0, length);
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof PayloadTooLargeException || error instanceof BadRequestException) throw error;
    throw new BadRequestException('无法读取图片：文件不存在、不可读、不是普通文件、含符号链接或读取期间发生变化。');
  }
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
