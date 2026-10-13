import { Controller, Delete, Get, HttpCode, Param, PayloadTooLargeException, Post, Query, Req, Res } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import type { Request, Response } from 'express';
import type { ChatAttachmentView } from '@worklite/contracts';
import { ChatAttachmentsService, MAX_ATTACHMENT_BYTES } from './chat-attachments.service';
import { WorkspaceService } from '../teams/teams.service';

// The API registers only JSON and urlencoded parsers, so image bodies arrive unread on the request stream.
async function readImageBody(request: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_ATTACHMENT_BYTES) throw new PayloadTooLargeException('图片不能超过 10 MB。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

@Controller('chat/attachments')
export class ChatAttachmentsController {
  constructor(private readonly attachments: ChatAttachmentsService, private readonly workspaces: WorkspaceService) {}

  @Post()
  async upload(@Req() request: Request, @Query() query: { fileName?: string; conversationId?: string; projectTaskId?: string }): Promise<ChatAttachmentView> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const body = await readImageBody(request);
    return this.attachments.create(workspace.id, { mimeType: request.headers['content-type'] ?? '', body, fileName: query.fileName, conversationId: query.conversationId, projectTaskId: query.projectTaskId });
  }

  @Get(':id')
  async download(@Req() request: Request, @Param('id') id: string, @Res() response: Response): Promise<void> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const { attachment, path } = this.attachments.open(workspace.id, id);
    const stream = createReadStream(path);
    stream.once('error', () => {
      if (!response.headersSent) response.status(404).json({ statusCode: 404, message: '图片已过期或不存在。' });
      else response.destroy();
    });
    stream.once('open', () => {
      response.setHeader('Content-Type', attachment.mimeType);
      response.setHeader('Content-Length', String(attachment.size));
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Cache-Control', `private, max-age=${Math.max(0, Math.floor((attachment.expiresAt.getTime() - Date.now()) / 1000))}`);
      response.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`);
      stream.pipe(response);
    });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() request: Request, @Param('id') id: string): Promise<void> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    await this.attachments.remove(workspace.id, id);
  }
}
