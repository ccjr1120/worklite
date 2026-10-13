import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NotFoundException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Database } from '@worklite/db';
import { ChatAttachmentsService, MAX_ATTACHMENT_BYTES, attachmentImagesAsText } from './chat-attachments.service';

const WORKSPACE_ID = 'workspace_personal';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

let db: Database;
let dataDirectory: string;

function service(environment: Record<string, string> = {}): ChatAttachmentsService {
  const values: Record<string, string> = { SQLITE_PATH: join(dataDirectory, 'worklite.db'), ...environment };
  return new ChatAttachmentsService(db, { get: (key: string) => values[key] } as unknown as ConfigService);
}

// Applies the real attachment migration to a minimal schema; the full migration chain is not needed here.
const MIGRATION = readFileSync(resolve(__dirname, '../../../../../packages/db/drizzle/0035_chat_attachments.sql'), 'utf8');

beforeEach(() => {
  dataDirectory = mkdtempSync(join(tmpdir(), 'worklite-attachments-'));
  db = createDb(':memory:');
  db.$client.exec('CREATE TABLE `workspaces` (`id` text PRIMARY KEY NOT NULL)');
  for (const statement of MIGRATION.split('--> statement-breakpoint')) db.$client.exec(statement);
  db.$client.prepare('INSERT INTO workspaces (id) VALUES (?)').run(WORKSPACE_ID);
});

afterEach(() => {
  db.$client.close();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe('ChatAttachmentsService', () => {
  it('stores an uploaded image under the data directory and reads it back', async () => {
    const attachments = service();
    const view = await attachments.create(WORKSPACE_ID, { mimeType: 'image/png', body: PNG, fileName: 'shot.png', projectTaskId: 'acall_task' });

    expect(view.id).toMatch(/^att_/);
    expect(view.url).toBe(`/api/chat/attachments/${view.id}`);
    expect(view.markdown).toBe(`![shot.png](/api/chat/attachments/${view.id})`);
    expect(new Date(view.expiresAt).getTime() - Date.now()).toBeGreaterThan(11.9 * 3_600_000);

    const { attachment, path } = attachments.open(WORKSPACE_ID, view.id);
    expect(path).toBe(join(dataDirectory, 'chat-attachments', view.id));
    expect(readFileSync(path)).toEqual(PNG);
    expect(attachment).toMatchObject({ fileName: 'shot.png', mimeType: 'image/png', size: PNG.length, projectTaskId: 'acall_task', conversationId: null });
  });

  it('rejects unsupported media types, empty bodies and oversized images', async () => {
    const attachments = service();
    await expect(attachments.create(WORKSPACE_ID, { mimeType: 'image/svg+xml', body: Buffer.from('<svg/>') })).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    await expect(attachments.create(WORKSPACE_ID, { mimeType: 'image/png', body: Buffer.alloc(0) })).rejects.toThrow('图片内容为空');
    await expect(attachments.create(WORKSPACE_ID, { mimeType: 'image/png', body: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) })).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('accepts a media type with parameters', async () => {
    const view = await service().create(WORKSPACE_ID, { mimeType: 'Image/JPEG; charset=binary', body: PNG });
    expect(view.mimeType).toBe('image/jpeg');
    expect(view.fileName).toBe(`${view.id}.jpg`);
  });

  it('deletes an attachment file and record', async () => {
    const attachments = service();
    const view = await attachments.create(WORKSPACE_ID, { mimeType: 'image/webp', body: PNG });
    const { path } = attachments.open(WORKSPACE_ID, view.id);

    await attachments.remove(WORKSPACE_ID, view.id);
    expect(existsSync(path)).toBe(false);
    expect(() => attachments.open(WORKSPACE_ID, view.id)).toThrow(NotFoundException);
    await expect(attachments.remove(WORKSPACE_ID, view.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('treats expired attachments as missing and prunes their files and records', async () => {
    const attachments = service({ CHAT_ATTACHMENT_RETENTION_HOURS: '1' });
    const expired = await attachments.create(WORKSPACE_ID, { mimeType: 'image/png', body: PNG });
    const { path } = attachments.open(WORKSPACE_ID, expired.id);
    const later = new Date(Date.now() + 2 * 3_600_000);

    expect(() => attachments.open(WORKSPACE_ID, expired.id, later)).toThrow(NotFoundException);
    expect(await attachments.prune(new Date())).toBe(0);
    expect(await attachments.prune(later)).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(db.$client.prepare('SELECT count(*) AS count FROM chat_attachments').get()).toEqual({ count: 0 });
  });

  it('defaults retention to 12 hours and ignores invalid configuration', () => {
    expect(service().retentionHours).toBe(12);
    expect(service({ CHAT_ATTACHMENT_RETENTION_HOURS: 'soon' }).retentionHours).toBe(12);
    expect(service({ CHAT_ATTACHMENT_RETENTION_HOURS: '0.5' }).retentionHours).toBe(0.5);
  });

  it('refuses ids that could escape the attachment directory', () => {
    expect(() => service().open(WORKSPACE_ID, '../worklite.db')).toThrow(NotFoundException);
  });
});

describe('attachmentImagesAsText', () => {
  it('replaces attachment images with a Web note and leaves other Markdown intact', () => {
    const markdown = 'Done.\n\n![首页截图](/api/chat/attachments/att_1234-ab)\n![](http://127.0.0.1:23391/api/chat/attachments/att_99)\n![logo](https://example.com/logo.png)';
    expect(attachmentImagesAsText(markdown)).toBe('Done.\n\n[图片：首页截图，请在 Web 查看]\n[图片：att_99，请在 Web 查看]\n![logo](https://example.com/logo.png)');
  });
});
