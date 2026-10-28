import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { WebFetchService, type WebFetchResponse } from './web-fetch.service';

// WorkLite's loopback API endpoint for Chat's web_fetch tool.
@Controller('web-search')
export class WebSearchController {
  constructor(private readonly pages: WebFetchService) {}

  @Post('fetch')
  @HttpCode(200)
  async fetchPage(@Body() body: unknown): Promise<WebFetchResponse> {
    return this.pages.fetchPage(body);
  }
}
