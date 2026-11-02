import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { createDb, initializeDatabase, type Database } from '@worklite/db';
import { ApiRequestLogsService, normalizeApiPath, type ApiRequestLogEntry } from './api-request-logs.service';

let db: Database;
let service: ApiRequestLogsService;

beforeEach(async () => {
  db = createDb(':memory:');
  await initializeDatabase(db);
  service = new ApiRequestLogsService(db);
});

afterEach(() => {
  service.onModuleDestroy();
  db.$client.close();
});

function entry(values: Partial<ApiRequestLogEntry> = {}): ApiRequestLogEntry {
  return { method: 'GET', route: '/api/runs', path: '/api/runs', status: 200, durationMs: 10, responseBytes: 100, streaming: false, startedAt: Date.now(), ...values };
}

describe('ApiRequestLogsService', () => {
  it('buffers entries and writes them on flush', () => {
    service.record(entry());
    expect(service.list({}).items).toHaveLength(0);
    service.flush();
    const [item] = service.list({}).items;
    expect(item).toMatchObject({ method: 'GET', route: '/api/runs', status: 200, durationMs: 10, responseBytes: 100, streaming: false });
  });

  it('pages newest first with a keyset cursor and no duplicates', () => {
    const base = Date.parse('2026-11-01T00:00:00.000Z');
    // Ten entries share one millisecond so the id tie-break decides their order.
    for (let index = 0; index < 25; index += 1) service.record(entry({ startedAt: base + (index < 10 ? 0 : index), durationMs: index }));
    service.flush();
    const seen: string[] = [];
    let cursor: string | undefined;
    let previous = Number.POSITIVE_INFINITY;
    do {
      const page = service.list({ from: new Date(base - 1).toISOString(), to: new Date(base + 1000).toISOString(), limit: 7, cursor });
      for (const item of page.items) {
        const at = Date.parse(item.occurredAt);
        expect(at).toBeLessThanOrEqual(previous);
        previous = at;
        seen.push(item.id);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it('filters by method, route, minimum duration and status class', () => {
    service.record(entry({ route: '/api/runs', durationMs: 5 }));
    service.record(entry({ route: '/api/runs', durationMs: 900 }));
    service.record(entry({ route: '/api/runs/:runId', durationMs: 50, status: 404 }));
    service.record(entry({ method: 'POST', route: '/api/commands', durationMs: 70, status: 503 }));
    service.flush();
    expect(service.list({ route: '/api/runs' }).items.map((item) => item.durationMs).sort((a, b) => a - b)).toEqual([5, 900]);
    expect(service.list({ minDurationMs: 60 }).items.map((item) => item.durationMs).sort((a, b) => a - b)).toEqual([70, 900]);
    expect(service.list({ method: 'post' }).items.map((item) => item.route)).toEqual(['/api/commands']);
    expect(service.list({ statusClass: 'client_error' }).items.map((item) => item.status)).toEqual([404]);
    expect(service.list({ statusClass: 'server_error' }).items.map((item) => item.status)).toEqual([503]);
    expect(service.list({ statusClass: 'success' }).items).toHaveLength(2);
  });

  it('ranks routes by p95 and leaves streaming requests out of the ranking', () => {
    for (let ms = 1; ms <= 20; ms += 1) service.record(entry({ route: '/api/runs', durationMs: ms * 10 }));
    service.record(entry({ route: '/api/coders', durationMs: 5, status: 500 }));
    service.record(entry({ route: '/api/coders', durationMs: 15 }));
    service.record(entry({ route: '/api/runs/:runId/events', durationMs: 600_000, streaming: true }));
    service.flush();
    const { routes } = service.stats({});
    expect(routes.map((row) => row.route)).toEqual(['/api/runs', '/api/coders']);
    // Nearest rank: the 19th of 20 sorted values.
    expect(routes[0]).toMatchObject({ count: 20, p95Ms: 190, maxMs: 200, avgMs: 105, errorCount: 0, avgBytes: 100 });
    expect(routes[1]).toMatchObject({ count: 2, p95Ms: 15, maxMs: 15, errorCount: 1 });
    // The streaming request is still listed.
    expect(service.list({ route: '/api/runs/:runId/events' }).items[0]).toMatchObject({ streaming: true });
  });

  it('removes rows older than the retention window', () => {
    const now = Date.now();
    service.record(entry({ startedAt: now - (service.retentionDays + 1) * 24 * 60 * 60 * 1000 }));
    service.record(entry({ startedAt: now - 1000 }));
    service.flush();
    expect(service.prune(now)).toBe(1);
    expect(service.list({ from: new Date(0).toISOString() }).items).toHaveLength(1);
  });

  it('times a request through the middleware with its route template', () => {
    const middleware = service.middleware();
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { 'content-length': '42', 'content-type': 'application/json' } as Record<string, string>,
      getHeader(name: string) { return this.headers[name]; },
    });
    const request = { method: 'GET', path: '/api/runs/run_1234abcd', baseUrl: '', route: undefined as { path: string } | undefined };
    let called = false;
    middleware(request as unknown as Request, response as unknown as Response, (() => { called = true; }) as NextFunction);
    expect(called).toBe(true);
    request.route = { path: '/api/runs/:runId' };
    response.emit('finish');
    response.emit('close');
    service.flush();
    const items = service.list({}).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ route: '/api/runs/:runId', path: '/api/runs/run_1234abcd', responseBytes: 42, streaming: false });
  });

  it('skips its own reads and the health probe', () => {
    const middleware = service.middleware();
    for (const path of ['/api/health', '/api/api-request-logs', '/api/api-request-logs/stats']) {
      const response = Object.assign(new EventEmitter(), { statusCode: 200, getHeader: () => undefined });
      middleware({ method: 'GET', path } as unknown as Request, response as unknown as Response, (() => undefined) as NextFunction);
      response.emit('finish');
    }
    service.flush();
    expect(service.list({}).items).toHaveLength(0);
  });
});

describe('normalizeApiPath', () => {
  it('collapses id-like segments', () => {
    expect(normalizeApiPath('/api/runs/run_18d5c683-c826-4e31-b071-5bdfa2a0cc52')).toBe('/api/runs/:id');
    expect(normalizeApiPath('/api/coders/company_coder/runs')).toBe('/api/coders/company_coder/runs');
    expect(normalizeApiPath('/api/coder-runs/atrun_9b0abb71c48f/events')).toBe('/api/coder-runs/:id/events');
    expect(normalizeApiPath('/api/items/123')).toBe('/api/items/:id');
  });
});
