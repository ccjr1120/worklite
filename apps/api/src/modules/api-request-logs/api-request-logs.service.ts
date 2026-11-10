import { BadRequestException, Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { ApiRequestLogItem, ApiRequestLogList, ApiRequestLogQuery, ApiRequestLogStats, ApiRequestLogStatusClass, ApiRequestRouteStat } from '@worklite/contracts';
import { databaseMaintenanceSettings, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { runtimeWritesFrozen } from '../../infrastructure/runtime-upgrade-state';

export type ApiRequestLogEntry = {
  method: string;
  route: string;
  path: string;
  status: number;
  durationMs: number;
  responseBytes: number | null;
  streaming: boolean;
  startedAt: number;
};

type LogRow = {
  id: string;
  method: string;
  route: string;
  path: string;
  status: number;
  duration_ms: number;
  response_bytes: number | null;
  streaming: number;
  created_at: number;
};

const FLUSH_INTERVAL_MS = 1_000;
const PRUNE_BATCH = 5_000;
const BUFFER_LIMIT = 5_000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const MAX_STAT_ROUTES = 200;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** Paths whose timing is not recorded: the log's own reads and the liveness probe. */
function skipped(path: string): boolean {
  return path === '/api/health' || path === '/api/api-request-logs' || path.startsWith('/api/api-request-logs/');
}

/**
 * A route template for a request Express did not match to a route (404s, requests
 * rejected before routing). Segments that look like ids collapse to :id so one
 * endpoint aggregates as one route.
 */
export function normalizeApiPath(path: string): string {
  return path.split('/').map((segment) => {
    if (!segment) return segment;
    if (/^\d+$/.test(segment)) return ':id';
    if (/^[0-9a-f-]{16,}$/i.test(segment)) return ':id';
    if (segment.length >= 8 && /\d/.test(segment) && /[_:@.%-]/.test(segment)) return ':id';
    return segment;
  }).join('/');
}

function routeTemplate(request: Request): string {
  const routePath = (request.route as { path?: unknown } | undefined)?.path;
  if (typeof routePath === 'string' && routePath) return `${request.baseUrl ?? ''}${routePath}`;
  return normalizeApiPath(request.path);
}

function retentionDaysFromEnv(): number {
  return databaseMaintenanceSettings().apiLogRetentionMs / DAY_MS;
}

function parseInstant(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new BadRequestException(`${name} must be an ISO timestamp.`);
  return parsed;
}

function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: number; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { createdAt?: unknown; id?: unknown };
    if (typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) && typeof value.id === 'string') return { createdAt: value.createdAt, id: value.id };
  } catch {
    // Falls through to the error below.
  }
  throw new BadRequestException('Invalid API request log cursor.');
}

function statusCondition(statusClass: ApiRequestLogStatusClass | undefined): string | null {
  if (statusClass === 'success') return 'status < 400';
  if (statusClass === 'client_error') return 'status >= 400 AND status < 500';
  if (statusClass === 'server_error') return 'status >= 500';
  return null;
}

function toItem(row: LogRow): ApiRequestLogItem {
  return {
    id: row.id,
    method: row.method,
    route: row.route,
    path: row.path,
    status: row.status,
    durationMs: row.duration_ms,
    responseBytes: row.response_bytes,
    streaming: row.streaming === 1,
    occurredAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * Times every request the local API serves and keeps the results in api_request_logs.
 *
 * Requests only push onto an in-memory buffer; one transaction per second writes the
 * buffer, so timing never adds a write transaction to a request. A failed flush is
 * logged and dropped, never surfaced to a request.
 */
@Injectable()
export class ApiRequestLogsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApiRequestLogsService.name);
  readonly retentionDays = retentionDaysFromEnv();
  private readonly enabled = process.env.WORKLITE_PREFLIGHT !== '1';
  private buffer: ApiRequestLogEntry[] = [];
  private dropped = 0;
  private flushTimer?: ReturnType<typeof setInterval>;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  onModuleInit(): void {
    // The isolated preflight candidate opens the live database file and must not write to it.
    if (!this.enabled) return;
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    this.flush();
  }

  /** Express middleware; registered first so every later handler, including 503 rejections, is timed. */
  middleware(): (request: Request, response: Response, next: NextFunction) => void {
    return (request, response, next) => {
      if (!this.enabled || skipped(request.path)) { next(); return; }
      const startedAt = Date.now();
      const start = process.hrtime.bigint();
      const path = request.path;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
          const length = Number(response.getHeader('content-length'));
          const contentType = String(response.getHeader('content-type') ?? '');
          this.record({
            method: request.method,
            route: routeTemplate(request),
            path,
            status: response.statusCode,
            durationMs,
            responseBytes: Number.isFinite(length) && length >= 0 ? length : null,
            streaming: contentType.includes('text/event-stream'),
            startedAt,
          });
        } catch {
          // Timing must never affect the response.
        }
      };
      response.once('finish', finish);
      response.once('close', finish);
      next();
    };
  }

  record(entry: ApiRequestLogEntry): void {
    if (!this.enabled) return;
    this.buffer.push(entry);
    if (this.buffer.length > BUFFER_LIMIT) {
      const overflow = this.buffer.length - BUFFER_LIMIT;
      this.buffer.splice(0, overflow);
      this.dropped += overflow;
    }
  }

  /** Writes the buffered entries in one transaction. */
  flush(): void {
    if (!this.buffer.length) return;
    const rows = this.buffer;
    this.buffer = [];
    try {
      // While the runtime hands the database to another version this process must not write.
      if (runtimeWritesFrozen()) return;
      const client = this.db.$client;
      const insert = client.prepare('INSERT INTO api_request_logs (id, method, route, path, status, duration_ms, response_bytes, streaming, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      client.transaction((entries: ApiRequestLogEntry[]) => {
        for (const entry of entries) insert.run(randomUUID(), entry.method, entry.route, entry.path, entry.status, entry.durationMs, entry.responseBytes, entry.streaming ? 1 : 0, entry.startedAt);
      })(rows);
    } catch (error) {
      this.logger.warn(`Writing ${rows.length} API request log rows failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.dropped) {
      this.logger.warn(`Dropped ${this.dropped} API request log rows because the write buffer was full.`);
      this.dropped = 0;
    }
  }

  /** Deletes rows older than the retention window in bounded batches. Returns the number removed. */
  prune(now = Date.now()): number {
    const cutoff = now - this.retentionDays * DAY_MS;
    const statement = this.db.$client.prepare('DELETE FROM api_request_logs WHERE id IN (SELECT id FROM api_request_logs WHERE created_at < ? LIMIT ?)');
    if (this.retentionDays <= 0) return 0;
    return statement.run(cutoff, PRUNE_BATCH).changes;
  }

  private range(query: ApiRequestLogQuery): { from: number; to: number } {
    const now = Date.now();
    const to = parseInstant(query.to, 'to') ?? now;
    const from = parseInstant(query.from, 'from') ?? to - (this.retentionDays || 1) * DAY_MS;
    if (from > to) throw new BadRequestException('from must not be later than to.');
    return { from, to };
  }

  list(query: ApiRequestLogQuery): ApiRequestLogList {
    const { from, to } = this.range(query);
    const limit = Math.min(Math.max(Number.isInteger(query.limit) ? query.limit! : DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const conditions = ['created_at >= ?', 'created_at <= ?'];
    const params: Array<string | number> = [from, to];
    if (query.method) { conditions.push('method = ?'); params.push(query.method.toUpperCase()); }
    if (query.route) { conditions.push('route = ?'); params.push(query.route); }
    if (query.minDurationMs !== undefined && Number.isFinite(query.minDurationMs)) { conditions.push('duration_ms >= ?'); params.push(query.minDurationMs); }
    const status = statusCondition(query.statusClass);
    if (status) conditions.push(status);
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const rows = this.db.$client.prepare(`SELECT id, method, route, path, status, duration_ms, response_bytes, streaming, created_at FROM api_request_logs WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params, limit + 1) as LogRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toItem),
      nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
      retentionDays: this.retentionDays,
    };
  }

  /** Per-route aggregates for non-streaming requests; p95 is the nearest-rank percentile. */
  stats(query: ApiRequestLogQuery): ApiRequestLogStats {
    const { from, to } = this.range(query);
    const conditions = ['created_at >= ?', 'created_at <= ?', 'streaming = 0'];
    const params: Array<string | number> = [from, to];
    if (query.method) { conditions.push('method = ?'); params.push(query.method.toUpperCase()); }
    const rows = this.db.$client.prepare(`
      WITH filtered AS (
        SELECT method, route, status, duration_ms, response_bytes FROM api_request_logs WHERE ${conditions.join(' AND ')}
      ),
      ranked AS (
        SELECT method, route, duration_ms,
          row_number() OVER (PARTITION BY method, route ORDER BY duration_ms) AS rank,
          count(*) OVER (PARTITION BY method, route) AS total
        FROM filtered
      ),
      percentile AS (
        SELECT method, route, duration_ms AS p95 FROM ranked WHERE rank = (95 * total + 99) / 100
      )
      SELECT filtered.method AS method, filtered.route AS route, count(*) AS count,
        avg(filtered.duration_ms) AS avgMs, max(filtered.duration_ms) AS maxMs,
        sum(CASE WHEN filtered.status >= 400 THEN 1 ELSE 0 END) AS errorCount,
        avg(filtered.response_bytes) AS avgBytes, percentile.p95 AS p95Ms
      FROM filtered JOIN percentile ON percentile.method = filtered.method AND percentile.route = filtered.route
      GROUP BY filtered.method, filtered.route
      ORDER BY p95Ms DESC, maxMs DESC
      LIMIT ?`).all(...params, MAX_STAT_ROUTES) as Array<{ method: string; route: string; count: number; avgMs: number; maxMs: number; errorCount: number; avgBytes: number | null; p95Ms: number }>;
    const routes: ApiRequestRouteStat[] = rows.map((row) => ({
      method: row.method,
      route: row.route,
      count: row.count,
      avgMs: Math.round(row.avgMs),
      p95Ms: row.p95Ms,
      maxMs: row.maxMs,
      errorCount: row.errorCount,
      avgBytes: row.avgBytes === null ? null : Math.round(row.avgBytes),
    }));
    return { routes, retentionDays: this.retentionDays };
  }
}
