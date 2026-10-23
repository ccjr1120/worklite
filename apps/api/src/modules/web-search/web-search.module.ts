import { Module } from '@nestjs/common';
import { WebSearchController } from './web-search.controller';
import { WebSearchCredentialService } from './web-search-credential.service';
import { VolcengineSearchService } from './volcengine-search.service';
import { WebFetchService } from './web-fetch.service';

@Module({
  controllers: [WebSearchController],
  providers: [WebSearchCredentialService, VolcengineSearchService, WebFetchService],
  exports: [WebSearchCredentialService, VolcengineSearchService, WebFetchService],
})
export class WebSearchModule {}
