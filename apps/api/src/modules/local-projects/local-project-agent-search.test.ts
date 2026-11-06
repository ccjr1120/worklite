import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalProjectsService, type LocalProjectSearchResponse } from './local-projects.service';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
const service = () => new LocalProjectsService({ get: () => undefined } as unknown as ConfigService);
const response = (overrides = {}) => ({ query: 'project', results: [], approximate: [], indexedProjects: 4, totalMatched: 0, partial: true, stale: true, timedOut: true, note: null, ...overrides }) as unknown as LocalProjectSearchResponse;

describe('Agent metadata-only local project lookup', () => {
  it('keeps an unmatched name distinct from a checked missing path', async () => {
    const lookup = service();
    vi.spyOn(lookup, 'search').mockResolvedValue(response());
    expect(await lookup.searchForAgent({ query: 'project' })).toMatchObject({ lookupStatus: 'not_indexed', requestedDirectory: null, partial: true, stale: true, timedOut: true });
    const root = mkdtempSync(join(tmpdir(), 'worklite-agent-search-'));
    roots.push(root);
    expect(await lookup.searchForAgent({ query: join(root, 'absent') })).toMatchObject({ lookupStatus: 'not_indexed', requestedDirectory: { directoryStatus: 'missing', errorCode: 'ENOENT' } });
    expect(await lookup.searchForAgent({ query: root })).toMatchObject({ lookupStatus: 'not_indexed', requestedDirectory: { absolutePath: root, directoryStatus: 'exists' } });
  });

  it('preserves multiple candidates and verifies both matches and suggestions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worklite-agent-search-'));
    roots.push(root);
    const lookup = service();
    const search = vi.spyOn(lookup, 'search').mockResolvedValue(response({ results: [{ absolutePath: root }, { absolutePath: join(root, 'removed'), matchedVia: 'alias', missing: true }], approximate: [{ absolutePath: root }], totalMatched: 2 }));
    const result = await lookup.searchForAgent({ query: 'project', limit: 5, refresh: true });
    expect(search).toHaveBeenCalledWith('project', { limit: 5, refresh: true });
    expect(result.lookupStatus).toBe('matched');
    expect(result.results.map((item) => item.directoryStatus)).toEqual(['exists', 'missing']);
    expect(result.approximate[0]?.directoryStatus).toBe('exists');
  });

  it('rejects malformed tool arguments before accessing the index', async () => {
    const lookup = service();
    const search = vi.spyOn(lookup, 'search');
    for (const input of [null, { query: '' }, { query: 4 }, { query: 'project', limit: 0 }, { query: 'project', refresh: 'true' }]) {
      await expect(lookup.searchForAgent(input)).rejects.toThrow();
    }
    expect(search).not.toHaveBeenCalled();
  });
});
