import { Module } from '@nestjs/common';
import { WebSearchController } from './web-search.controller';
import { VolcengineSearchService } from './volcengine-search.service';
import { WebFetchService } from './web-fetch.service';

@Module({
  controllers: [WebSearchController],
  providers: [VolcengineSearchService, WebFetchService],
  exports: [VolcengineSearchService, WebFetchService],
})
export class WebSearchModule {}
