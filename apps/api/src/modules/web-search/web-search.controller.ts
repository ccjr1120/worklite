import { Body, Controller, Delete, Get, HttpCode, Post, Put } from '@nestjs/common';
import { WebSearchCredentialService, type WebSearchCredentialStatus } from './web-search-credential.service';
import { VolcengineSearchService, type WebSearchResponse } from './volcengine-search.service';
import { WebFetchService, type WebFetchResponse } from './web-fetch.service';

// WorkLite's loopback API endpoints for Chat and the workspace UI. The
// credential service encrypts keys before storage; these routes never return a
// key, and the settings test returns only a result count.
@Controller('web-search')
export class WebSearchController {
  constructor(
    private readonly credentials: WebSearchCredentialService,
    private readonly searches: VolcengineSearchService,
    private readonly pages: WebFetchService,
  ) {}

  @Get('settings')
  settings(): Promise<WebSearchCredentialStatus> {
    return this.credentials.status();
  }

  @Put('settings')
  saveSettings(@Body() body: { apiKey?: unknown }): Promise<WebSearchCredentialStatus> {
    return this.credentials.save(body?.apiKey);
  }

  @Post('settings/test')
  @HttpCode(200)
  async testSettings(@Body() body: { query?: unknown }): Promise<{ configured: true; resultCount: number }> {
    const result = await this.searches.search({ query: body?.query, count: 1 }, await this.credentials.read());
    return { configured: true, resultCount: result.resultCount ?? result.results.length };
  }

  @Delete('settings')
  clearSettings(): Promise<WebSearchCredentialStatus> {
    return this.credentials.clear();
  }

  @Post('search')
  @HttpCode(200)
  async search(@Body() body: unknown): Promise<WebSearchResponse> {
    return this.searches.search(body, await this.credentials.read());
  }

  @Post('fetch')
  @HttpCode(200)
  async fetchPage(@Body() body: unknown): Promise<WebFetchResponse> {
    return this.pages.fetchPage(body);
  }
}
