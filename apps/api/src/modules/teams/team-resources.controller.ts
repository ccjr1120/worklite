import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { CreateMcpServerRequest, CreateModelProviderRequest, CreateSkillRequest, ExecuteSkillScriptRequest, UpdateSkillRequest, UpdateWorkspaceSettingsRequest } from '@worklite/contracts';
import { WorkspaceResourcesService } from './team-resources.service';

@Controller()
export class WorkspaceResourcesController {
  constructor(private readonly resources: WorkspaceResourcesService) {}

  @Get('skills')
  skills(@Req() request: Request) { return this.resources.skills(request, 'personal'); }

  @Get('skills/:skillId')
  skill(@Req() request: Request, @Param('skillId') skillId: string) { return this.resources.skill(request, 'personal', skillId); }

  @Post('skills')
  createSkill(@Req() request: Request, @Body() body: CreateSkillRequest) { return this.resources.createSkill(request, 'personal', body); }

  @Patch('skills/:skillId')
  updateSkill(@Req() request: Request, @Param('skillId') skillId: string, @Body() body: UpdateSkillRequest) { return this.resources.updateSkill(request, 'personal', skillId, body); }

  @Post('skills/:skillId/executions')
  executeSkillScript(@Req() request: Request, @Param('skillId') skillId: string, @Body() body: ExecuteSkillScriptRequest) { return this.resources.executeSkillScript(request, 'personal', skillId, body); }

  @Get('mcp-servers')
  mcpServers(@Req() request: Request) { return this.resources.mcpServers(request, 'personal'); }

  @Get('mcp-servers/:serverId')
  mcpServer(@Req() request: Request, @Param('serverId') serverId: string) { return this.resources.mcpServer(request, 'personal', serverId); }

  @Post('mcp-servers')
  createMcpServer(@Req() request: Request, @Body() body: CreateMcpServerRequest) { return this.resources.createMcpServer(request, 'personal', body); }

  @Get('model-providers')
  providers(@Req() request: Request) { return this.resources.providers(request, 'personal'); }

  @Get('platform/snapshot')
  platformSnapshot(@Req() request: Request) { return this.resources.platformSnapshot(request, 'personal'); }

  @Get('settings')
  settings(@Req() request: Request) { return this.resources.settings(request, 'personal'); }

  @Patch('settings')
  updateSettings(@Req() request: Request, @Body() body: UpdateWorkspaceSettingsRequest) { return this.resources.updateSettings(request, 'personal', body); }

  @Post('navigation/resolve')
  resolveNavigation(@Req() request: Request, @Body() body: { target?: unknown }) { return this.resources.resolveNavigation(request, 'personal', body); }

  @Post('model-providers')
  upsertProvider(@Req() request: Request, @Body() body: CreateModelProviderRequest) { return this.resources.upsertProvider(request, 'personal', body); }

  @Post('model-providers/:providerId/test')
  testProvider(@Req() request: Request, @Param('providerId') providerId: string) { return this.resources.testProvider(request, 'personal', providerId); }

  @Delete('model-providers/:providerId')
  deleteProvider(@Req() request: Request, @Param('providerId') providerId: string) { return this.resources.deleteProvider(request, 'personal', providerId); }

  @Get('artifacts')
  artifacts(@Req() request: Request) { return this.resources.artifactsList(request, 'personal'); }

  @Get('artifacts/:artifactId')
  artifact(@Req() request: Request, @Param('artifactId') artifactId: string) { return this.resources.artifact(request, 'personal', artifactId); }

  @Get('usage')
  usage(@Req() request: Request) { return this.resources.usage(request, 'personal'); }

  @Get('audit-logs')
  audit(@Req() request: Request) { return this.resources.audit(request, 'personal'); }
}
