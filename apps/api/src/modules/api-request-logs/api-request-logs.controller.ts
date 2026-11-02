import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import type { ApiRequestLogList, ApiRequestLogQuery, ApiRequestLogStats } from '@worklite/contracts';
import { ApiRequestLogsService } from './api-request-logs.service';

type RawQuery = Record<string, unknown>;

function queryText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function queryNumber(value: unknown, name: string): number | undefined {
  const text = queryText(value);
  if (text === undefined) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) throw new BadRequestException(`${name} must be a non-negative number.`);
  return parsed;
}

function parseQuery(query: RawQuery): ApiRequestLogQuery {
  const statusClass = queryText(query.statusClass);
  const limit = queryNumber(query.limit, 'limit');
  return {
    from: queryText(query.from),
    to: queryText(query.to),
    method: queryText(query.method),
    route: queryText(query.route),
    minDurationMs: queryNumber(query.minDurationMs, 'minDurationMs'),
    statusClass: statusClass === 'success' || statusClass === 'client_error' || statusClass === 'server_error' ? statusClass : undefined,
    limit: limit === undefined ? undefined : Math.floor(limit),
    cursor: queryText(query.cursor),
  };
}

@Controller('api-request-logs')
export class ApiRequestLogsController {
  constructor(private readonly logs: ApiRequestLogsService) {}

  @Get()
  list(@Query() query: RawQuery): ApiRequestLogList {
    return this.logs.list(parseQuery(query));
  }

  @Get('stats')
  stats(@Query() query: RawQuery): ApiRequestLogStats {
    return this.logs.stats(parseQuery(query));
  }
}
