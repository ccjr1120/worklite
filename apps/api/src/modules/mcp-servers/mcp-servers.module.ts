import { Module } from '@nestjs/common';
import { McpClientService } from './mcp-client.service';
import { VolcengineSearchMcpController } from './volcengine-search-mcp.controller';
import { WebSearchModule } from '../web-search/web-search.module';

@Module({
  imports: [WebSearchModule],
  controllers: [VolcengineSearchMcpController],
  providers: [McpClientService],
  exports: [McpClientService],
})
export class McpServersModule {}
