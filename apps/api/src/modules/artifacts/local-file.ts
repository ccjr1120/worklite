import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, sep } from 'node:path';

// WorkLite budgets, not verified iLink server limits. All regular file types are opaque bytes.
export const MAX_LOCAL_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_LOCAL_FILE_BATCH_BYTES = 40 * 1024 * 1024;
export const MAX_LOCAL_FILES = 8;

/** Local paths are input only: never include them (including filesystem errors) in a result. */
export async function readLocalFile(path: string, maxBytes: number, noun = '文件'): Promise<Buffer> {
  if (!isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).includes('..')) {
    throw new BadRequestException(`${noun}路径必须是无路径穿越的本地绝对路径。`);
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
      if (before.size > maxBytes) throw new PayloadTooLargeException(`${noun}不能超过 ${maxBytes / 1024 / 1024} MB。`);
      // A bounded read also covers files that grow after stat; readFile alone would not.
      const body = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
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
      if (!length) throw new BadRequestException(`${noun}内容为空。`);
      return body.subarray(0, length);
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof PayloadTooLargeException || error instanceof BadRequestException) throw error;
    throw new BadRequestException(`无法读取${noun}：文件不存在、不可读、不是普通文件、含符号链接或读取期间发生变化。`);
  }
}

export function safeFileName(value: string): string {
  return Array.from(value.split(/[\\/]/).at(-1)!.replace(/[\p{Cc}\u2028\u2029]/gu, '_').trim()).slice(0, 200).join('') || 'file';
}

export function fileMarkdown(name: string, url: string): string {
  return `[${name.replace(/[[\]\\()<>`*_!]/g, ' ').trim() || '文件'}](${url})`;
}
