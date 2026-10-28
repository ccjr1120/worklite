import { Module } from '@nestjs/common';
import { WebSearchController } from './web-search.controller';
import { WebFetchService } from './web-fetch.service';

@Module({
  controllers: [WebSearchController],
  providers: [WebFetchService],
  exports: [WebFetchService],
})
export class WebSearchModule {}
