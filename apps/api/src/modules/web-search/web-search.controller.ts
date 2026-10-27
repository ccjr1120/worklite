import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { readWebSearchApiKey } from './web-search-api-key';
import { VolcengineSearchService, type WebSearchResponse } from './volcengine-search.service';
import { WebFetchService, type WebFetchResponse } from './web-fetch.service';

// WorkLite's loopback API endpoints for Chat's web_search and web_fetch tools.
// The search key comes from the API process environment; it is never accepted,
// stored or returned over this API.
@Controller('web-search')
export class WebSearchController {
  constructor(
    private readonly searches: VolcengineSearchService,
    private readonly pages: WebFetchService,
  ) {}

  @Post('search')
  @HttpCode(200)
  async search(@Body() body: unknown): Promise<WebSearchResponse> {
    return this.searches.search(body, readWebSearchApiKey());
  }

  @Post('fetch')
  @HttpCode(200)
  async fetchPage(@Body() body: unknown): Promise<WebFetchResponse> {
    return this.pages.fetchPage(body);
  }
}
