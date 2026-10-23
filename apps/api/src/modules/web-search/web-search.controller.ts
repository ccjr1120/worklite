import { Body, Controller, Delete, Get, HttpCode, Post, Put } from '@nestjs/common';
import { WebSearchCredentialService, type WebSearchCredentialStatus } from './web-search-credential.service';
import { VolcengineSearchService, type WebSearchResponse } from './volcengine-search.service';
import { WebFetchService, type WebFetchResponse } from './web-fetch.service';

// Internal, side-effect-free endpoints. Chat's protected platform scripts call
// them over the existing local API URL; they never read the database or a key
// themselves, and never return the key.
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
