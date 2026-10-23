import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { LocalProjectsService } from './local-projects.service';

export type SetLocalProjectAliasBody = {
  alias?: string;
  absolutePath?: string;
  note?: string | null;
};

@Controller('local-projects')
export class LocalProjectsController {
  constructor(private readonly localProjects: LocalProjectsService) {}

  @Get('search')
  search(
    @Query('query') query?: string,
    @Query('limit') limit?: string,
    @Query('refresh') refresh?: string,
  ) {
    const parsedLimit = limit === undefined || limit === '' ? undefined : Number(limit);
    return this.localProjects.search(query ?? '', {
      limit: parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      refresh: refresh === 'true' || refresh === '1',
    });
  }

  @Get('index')
  index() {
    return this.localProjects.status();
  }

  @Get('aliases')
  listAliases(@Query('query') query?: string) {
    return this.localProjects.listAliases(query);
  }

  @Put('aliases')
  setAlias(@Body() body: SetLocalProjectAliasBody) {
    return this.localProjects.setAlias(body ?? {});
  }

  @Delete('aliases/:alias')
  removeAlias(@Param('alias') alias: string) {
    return this.localProjects.removeAlias(alias);
  }
}
