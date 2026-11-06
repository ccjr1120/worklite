import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Query, Req, StreamableFile } from '@nestjs/common';
import type { Request } from 'express';
import type { CreateMcpServerRequest, CreateSkillRequest, ExecuteSkillScriptRequest, ImportSkillRequest, UpdateMcpServerRequest, UpdateWorkspaceSettingsRequest } from '@worklite/contracts';
import { WorkspaceResourcesService } from './team-resources.service';
import { LocalFileArtifactsService } from '../artifacts/local-file-artifacts.service';
import { LocalImageArtifactsService } from '../artifacts/local-image-artifacts.service';
import { WorkspaceService } from './teams.service';

@Controller()
export class WorkspaceResourcesController {
  constructor(private readonly resources: WorkspaceResourcesService, private readonly localImages: LocalImageArtifactsService, private readonly workspaces: WorkspaceService, private readonly localFiles: LocalFileArtifactsService) {}

  @Post('artifacts/local-images')
  async importLocalImages(@Req() request: Request, @Body() body: unknown) {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    return this.localImages.importImages(workspace.id, body);
  }

  @Post('artifacts/local-files')
  async importLocalFiles(@Req() request: Request, @Body() body: unknown) {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    return this.localFiles.importFiles(workspace.id, body);
  }

  @Get('skills')
  skills(@Req() request: Request) { return this.resources.skills(request, 'personal'); }

  @Post('skills/import')
  importSkill(@Req() request: Request, @Body() body: ImportSkillRequest) { return this.resources.importSkill(request, 'personal', body); }

  @Get('skills/:skillId')
  skill(@Req() request: Request, @Param('skillId') skillId: string) { return this.resources.skill(request, 'personal', skillId); }

  @Post('skills')
  createSkill(@Req() request: Request, @Body() body: CreateSkillRequest) { return this.resources.createSkill(request, 'personal', body); }

  @Delete('skills/:skillId')
  deleteSkill(@Req() request: Request, @Param('skillId') skillId: string) { return this.resources.deleteSkill(request, 'personal', skillId); }

  @Post('skills/:skillId/executions')
  executeSkillScript(@Req() request: Request, @Param('skillId') skillId: string, @Body() body: ExecuteSkillScriptRequest) { return this.resources.executeSkillScript(request, 'personal', skillId, body); }

  @Get('mcp-servers')
  mcpServers(@Req() request: Request) { return this.resources.mcpServers(request, 'personal'); }

  @Get('mcp-servers/:serverId')
  mcpServer(@Req() request: Request, @Param('serverId') serverId: string) { return this.resources.mcpServer(request, 'personal', serverId); }

  @Post('mcp-servers')
  createMcpServer(@Req() request: Request, @Body() body: CreateMcpServerRequest) { return this.resources.createMcpServer(request, 'personal', body); }

  @Patch('mcp-servers/:serverId')
  updateMcpServer(@Req() request: Request, @Param('serverId') serverId: string, @Body() body: UpdateMcpServerRequest) { return this.resources.updateMcpServer(request, 'personal', serverId, body); }

  @Delete('mcp-servers/:serverId')
  deleteMcpServer(@Req() request: Request, @Param('serverId') serverId: string, @Query('force') force?: string) { return this.resources.deleteMcpServer(request, 'personal', serverId, { force: force === 'true' }); }

  @Post('mcp-servers/:serverId/test')
  testMcpServer(@Req() request: Request, @Param('serverId') serverId: string) { return this.resources.testMcpServer(request, 'personal', serverId); }

  @Get('platform/snapshot')
  platformSnapshot(@Req() request: Request) { return this.resources.platformSnapshot(request, 'personal'); }

  @Get('settings')
  settings(@Req() request: Request) { return this.resources.settings(request, 'personal'); }

  @Patch('settings')
  updateSettings(@Req() request: Request, @Body() body: UpdateWorkspaceSettingsRequest) { return this.resources.updateSettings(request, 'personal', body); }

  @Post('navigation/resolve')
  resolveNavigation(@Req() request: Request, @Body() body: { target?: unknown }) { return this.resources.resolveNavigation(request, 'personal', body); }

  @Get('artifacts')
  artifacts(
    @Req() request: Request,
    @Query('search') search?: string,
    @Query('workflowId') workflowId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.resources.artifactsList(request, 'personal', {
      search,
      workflowId,
      page: page === undefined ? undefined : Number(page),
      pageSize: pageSize === undefined ? undefined : Number(pageSize),
    });
  }

  @Get('artifacts/:artifactId')
  artifact(@Req() request: Request, @Param('artifactId') artifactId: string) { return this.resources.artifact(request, 'personal', artifactId); }

  @Get('artifacts/:artifactId/content')
  @Header('X-Content-Type-Options', 'nosniff')
  async artifactContent(@Req() request: Request, @Param('artifactId') artifactId: string, @Query('download') download?: string) {
    const file = await this.resources.artifactContent(request, 'personal', artifactId);
    const disposition = download === 'true' || !file.isImage ? 'attachment' : 'inline';
    return new StreamableFile(file.content, {
      type: file.mimeType,
      disposition: file.isImage ? `${disposition}; filename="${file.fileName}"` : `${disposition}; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      length: file.sizeBytes,
    });
  }

  @Delete('artifacts/:artifactId')
  deleteArtifact(@Req() request: Request, @Param('artifactId') artifactId: string) { return this.resources.deleteArtifact(request, 'personal', artifactId); }

  @Get('usage')
  usage(@Req() request: Request) { return this.resources.usage(request, 'personal'); }

  @Get('audit-logs')
  audit(@Req() request: Request) { return this.resources.audit(request, 'personal'); }

}
