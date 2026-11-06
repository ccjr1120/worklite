import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { WechatDraftRevisionService, type ReviseDraftRequest } from './wechat-draft-revision.service';

// Revise a WeChat draft that a Workflow Run saved. Every route is addressed by
// the Run id and the draft id together so a request cannot reach another draft.
@Controller('runs/:runId/wechat-drafts/:draftId')
export class WechatDraftsController {
  constructor(private readonly revisions: WechatDraftRevisionService) {}

  @Get()
  inspect(@Param('runId') runId: string, @Param('draftId') draftId: string) {
    return this.revisions.inspect(runId, draftId);
  }

  @Post('verify')
  verify(@Param('runId') runId: string, @Param('draftId') draftId: string) {
    return this.revisions.verify(runId, draftId);
  }

  @Post('images')
  renderImage(@Param('runId') runId: string, @Param('draftId') draftId: string, @Body() body: { key?: unknown; html?: unknown; width?: unknown; height?: unknown }) {
    return this.revisions.renderImage(runId, draftId, body ?? {});
  }

  @Post('revisions')
  revise(@Param('runId') runId: string, @Param('draftId') draftId: string, @Body() body: ReviseDraftRequest) {
    return this.revisions.revise(runId, draftId, body ?? {});
  }

  @Get('revisions/:revisionId')
  getRevision(@Param('runId') runId: string, @Param('draftId') draftId: string, @Param('revisionId') revisionId: string) {
    return this.revisions.getRevision(runId, draftId, revisionId);
  }

  @Post('revisions/:revisionId/resolve')
  resolve(@Param('runId') runId: string, @Param('draftId') draftId: string, @Param('revisionId') revisionId: string, @Body() body: { outcome?: unknown; note?: unknown }) {
    return this.revisions.resolve(runId, draftId, revisionId, body ?? {});
  }
}
