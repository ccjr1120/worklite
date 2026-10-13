import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { chatAttachments, type Database } from '@worklite/db';
import type { ChatAttachmentView } from '@worklite/contracts';
import { DATABASE } from '../../infrastructure/database.module';

type Attachment = typeof chatAttachments.$inferSelect;

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// SVG is excluded because an inline SVG document can carry script.
export const ATTACHMENT_MIME_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const DEFAULT_RETENTION_HOURS = 12;
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const ATTACHMENT_ROUTE = '/api/chat/attachments/';
const ATTACHMENT_IMAGE = /!\[([^\]\n]*)\]\((?:https?:\/\/[^\s)]*?)?\/api\/chat\/attachments\/(att_[A-Za-z0-9-]+)\)/g;

/** Replaces attachment image references for channels that cannot load WorkLite URLs. */
export function attachmentImagesAsText(markdown: string): string {
  return markdown.replace(ATTACHMENT_IMAGE, (_match, alt: string, id: string) => `[图片：${alt.trim() || id}，请在 Web 查看]`);
}

@Injectable()
export class ChatAttachmentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatAttachmentsService.name);
  private timer: NodeJS.Timeout | undefined;
  readonly retentionHours: number;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly config: ConfigService,
  ) {
    const configured = this.config.get<string>('CHAT_ATTACHMENT_RETENTION_HOURS');
    const hours = configured === undefined || configured === '' ? DEFAULT_RETENTION_HOURS : Number(configured);
    if (!Number.isFinite(hours) || hours <= 0) this.logger.warn(`CHAT_ATTACHMENT_RETENTION_HOURS=${configured} is not a positive number; using ${DEFAULT_RETENTION_HOURS} hours.`);
    this.retentionHours = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_RETENTION_HOURS;
  }

  onModuleInit(): void {
    if (process.env.WORKLITE_PREFLIGHT === '1') return;
    this.timer = setInterval(() => void this.pruneSafely(), PRUNE_INTERVAL_MS);
    this.timer.unref();
    void this.pruneSafely();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async create(workspaceId: string, input: { mimeType: string; body: Buffer; fileName?: string; conversationId?: string; projectTaskId?: string }): Promise<ChatAttachmentView> {
    const mimeType = input.mimeType.split(';')[0]!.trim().toLowerCase();
    const extension = ATTACHMENT_MIME_TYPES[mimeType];
    if (!extension) throw new UnsupportedMediaTypeException('仅支持 PNG、JPEG、GIF 或 WebP 图片。');
    if (input.body.length === 0) throw new BadRequestException('图片内容为空。');
    if (input.body.length > MAX_ATTACHMENT_BYTES) throw new PayloadTooLargeException('图片不能超过 10 MB。');
    const id = `att_${randomUUID()}`;
    const fileName = input.fileName?.replace(/[\\/\r\n]/g, '_').trim().slice(0, 200) || `${id}.${extension}`;
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.retentionHours * 3_600_000);
    const path = this.filePath(id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.body);
    try {
      this.db.insert(chatAttachments).values({
        id, workspaceId, fileName, mimeType, size: input.body.length,
        conversationId: input.conversationId || null, projectTaskId: input.projectTaskId || null, createdAt, expiresAt,
      }).run();
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    return this.view({ id, fileName, mimeType, size: input.body.length, expiresAt });
  }

  /** Returns a live attachment and its file path; expired records are treated as already removed. */
  open(workspaceId: string, id: string, now = new Date()): { attachment: Attachment; path: string } {
    const attachment = this.db.select().from(chatAttachments).where(and(eq(chatAttachments.id, id), eq(chatAttachments.workspaceId, workspaceId))).get();
    if (!attachment || attachment.expiresAt.getTime() <= now.getTime()) throw new NotFoundException('图片已过期或不存在。');
    return { attachment, path: this.filePath(id) };
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const deleted = this.db.delete(chatAttachments).where(and(eq(chatAttachments.id, id), eq(chatAttachments.workspaceId, workspaceId))).returning({ id: chatAttachments.id }).all();
    if (!deleted.length) throw new NotFoundException('图片已过期或不存在。');
    await rm(this.filePath(id), { force: true });
  }

  /** Deletes expired attachment records and their files; returns the number removed. */
  async prune(now = new Date()): Promise<number> {
    const expired = this.db.select({ id: chatAttachments.id }).from(chatAttachments).where(lte(chatAttachments.expiresAt, now)).all();
    if (!expired.length) return 0;
    const ids = expired.map((row) => row.id);
    this.db.delete(chatAttachments).where(inArray(chatAttachments.id, ids)).run();
    await Promise.all(ids.map((id) => rm(this.filePath(id), { force: true })));
    return ids.length;
  }

  private async pruneSafely(): Promise<void> {
    try {
      const removed = await this.prune();
      if (removed) this.logger.log(`Removed ${removed} expired Chat attachment(s).`);
    } catch (error) {
      this.logger.warn(`Chat attachment cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private filePath(id: string): string {
    if (!/^att_[A-Za-z0-9-]+$/.test(id)) throw new NotFoundException('图片已过期或不存在。');
    const configuredSqlitePath = this.config.get<string>('SQLITE_PATH') ?? '../../.data/deployment/worklite.db';
    const sqlitePath = isAbsolute(configuredSqlitePath) ? configuredSqlitePath : resolve(process.cwd(), configuredSqlitePath);
    return resolve(dirname(sqlitePath), 'chat-attachments', id);
  }

  private view(attachment: Pick<Attachment, 'id' | 'fileName' | 'mimeType' | 'size' | 'expiresAt'>): ChatAttachmentView {
    const url = `${ATTACHMENT_ROUTE}${attachment.id}`;
    const alt = attachment.fileName.replace(/[[\]()\n]/g, ' ').trim();
    return { id: attachment.id, fileName: attachment.fileName, mimeType: attachment.mimeType, size: attachment.size, url, markdown: `![${alt}](${url})`, expiresAt: attachment.expiresAt.toISOString() };
  }
}
