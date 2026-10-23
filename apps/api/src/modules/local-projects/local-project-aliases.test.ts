import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aliasKey,
  normalizeAlias,
  normalizeAliasTarget,
  readAliasDocument,
  removeAlias,
  serializeAliasDocument,
  upsertAlias,
  writeAliasDocument,
  type LocalProjectAliasRecord,
} from './local-project-aliases';
import { LocalProjectsService } from './local-projects.service';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'worklite-local-project-aliases-'));
  roots.push(root);
  return root;
}

function createRepo(path: string): void {
  mkdirSync(join(path, '.git'), { recursive: true });
  writeFileSync(join(path, '.git', 'HEAD'), 'ref: refs/heads/main\n');
}

function entry(overrides: Partial<LocalProjectAliasRecord> = {}): LocalProjectAliasRecord {
  return {
    alias: 'dino-datahub',
    absolutePath: '/development/company/dino/dino-app',
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('local project alias dictionary', () => {
  it('adds, updates in place and removes aliases case-insensitively', () => {
    const root = tempRoot();
    const target = join(root, 'company', 'dino', 'dino-app');
    const other = join(root, 'company', 'dino', 'other');
    mkdirSync(target, { recursive: true });
    mkdirSync(other, { recursive: true });

    const added = upsertAlias([], { alias: '  Dino DataHub ', absolutePath: 'company/dino/dino-app/', root, now: () => new Date('2026-02-01T00:00:00Z') });
    expect(added.created).toBe(true);
    expect(added.entry).toMatchObject({
      alias: 'Dino DataHub',
      absolutePath: target,
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });

    const updated = upsertAlias(added.aliases, { alias: 'dino datahub', absolutePath: './company/dino/other', note: 'renamed target', root, now: () => new Date('2026-03-01T00:00:00Z') });
    expect(updated.created).toBe(false);
    expect(updated.aliases).toHaveLength(1);
    expect(updated.entry).toMatchObject({
      alias: 'dino datahub',
      absolutePath: other,
      note: 'renamed target',
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
    });

    const removed = removeAlias(updated.aliases, 'DINO DATAHUB');
    expect(removed.removed?.alias).toBe('dino datahub');
    expect(removed.aliases).toEqual([]);
    expect(removeAlias(removed.aliases, 'dino datahub').removed).toBeNull();
  });

  it('rejects missing directories, non-directories and paths outside the project root', () => {
    const root = tempRoot();
    const file = join(root, 'company', 'not-a-directory');
    mkdirSync(join(root, 'company'), { recursive: true });
    writeFileSync(file, 'x');

    expect(() => normalizeAliasTarget('company/missing', root)).toThrow(/existing directory/);
    expect(() => normalizeAliasTarget('company/not-a-directory', root)).toThrow(/existing directory/);
    expect(() => normalizeAliasTarget(join(root, '..', 'elsewhere'), root)).toThrow(/inside the local project root/);
    expect(() => normalizeAliasTarget('/', root)).toThrow(/inside the local project root/);
  });

  it('normalizes relative paths, trailing slashes and repeated separators', () => {
    const root = tempRoot();
    const target = join(root, 'company', 'dino', 'dino-app');
    mkdirSync(target, { recursive: true });

    expect(normalizeAliasTarget('company/dino/dino-app/', root)).toBe(target);
    expect(normalizeAliasTarget('./company//dino/dino-app', root)).toBe(target);
    expect(normalizeAliasTarget(`${target}///`, root)).toBe(target);
  });

  it('degrades a damaged file to an empty dictionary without losing later writes', () => {
    const directory = tempRoot();
    const path = join(directory, 'local-project-aliases.json');
    const root = tempRoot();
    mkdirSync(join(root, 'company', 'dino', 'dino-app'), { recursive: true });
    writeFileSync(path, '{ not json', 'utf8');

    const damaged = readAliasDocument(path);
    expect(damaged.aliases).toEqual([]);
    expect(damaged.error).toContain('not valid JSON');

    const { aliases } = upsertAlias(damaged.aliases, { alias: 'dino-datahub', absolutePath: 'company/dino/dino-app', root });
    writeAliasDocument(path, aliases);
    const recovered = readAliasDocument(path);
    expect(recovered.error).toBeNull();
    expect(recovered.aliases.map((item) => item.alias)).toEqual(['dino-datahub']);
  });

  it('treats a missing file as an empty dictionary and writes atomically through a temporary file', () => {
    const directory = tempRoot();
    const path = join(directory, 'nested', 'local-project-aliases.json');
    const root = tempRoot();
    mkdirSync(join(root, 'self', 'app'), { recursive: true });

    expect(readAliasDocument(path)).toEqual({ aliases: [], error: null });
    const { aliases, entry: saved } = upsertAlias([], { alias: '数据平台', absolutePath: join(root, 'self', 'app'), root });
    writeAliasDocument(path, aliases);

    const document = JSON.parse(readFileSync(path, 'utf8')) as { version: number; aliases: Array<{ alias: string }> };
    expect(document.version).toBe(1);
    expect(document.aliases.map((item) => item.alias)).toEqual(['数据平台']);
    expect(serializeAliasDocument(aliases)).toContain('数据平台');
    expect(saved.alias).toBe('数据平台');
  });

  it('keeps one entry per alias key when a file contains duplicates', () => {
    const directory = tempRoot();
    const path = join(directory, 'local-project-aliases.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      aliases: [entry({ alias: 'Dino-DataHub', absolutePath: '/development/company/dino/old' }), entry({ alias: 'dino-datahub', absolutePath: '/development/company/dino/new' })],
    }));

    const loaded = readAliasDocument(path);
    expect(loaded.aliases).toHaveLength(1);
    expect(loaded.aliases[0]!.absolutePath).toBe('/development/company/dino/new');
    expect(aliasKey(' Dino-DataHub ')).toBe('dino-datahub');
    expect(normalizeAlias('  a   b ')).toBe('a b');
  });
});

describe('LocalProjectsService alias operations', () => {
  function config(values: Record<string, string>): ConfigService {
    return { get: (key: string) => values[key] } as unknown as ConfigService;
  }

  function serviceFor(root: string, dataDirectory = tempRoot()): LocalProjectsService {
    return new LocalProjectsService(config({
      WORKLITE_LOCAL_PROJECTS_ROOT: root,
      WORKLITE_LOCAL_PROJECTS_INDEX_PATH: join(dataDirectory, 'local-projects.json'),
    }));
  }

  it('derives the alias file next to the index and applies an explicit override', async () => {
    const root = tempRoot();
    const dataDirectory = tempRoot();
    const service = serviceFor(root, dataDirectory);
    expect((await service.listAliases()).path).toBe(join(dataDirectory, 'local-project-aliases.json'));

    const overridden = new LocalProjectsService(config({
      WORKLITE_LOCAL_PROJECTS_ROOT: root,
      WORKLITE_LOCAL_PROJECTS_ALIASES_PATH: join(dataDirectory, 'custom.json'),
    }));
    expect((await overridden.listAliases()).path).toBe(join(dataDirectory, 'custom.json'));
  });

  it('saves, lists, filters and removes aliases, and rejects unknown aliases on removal', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'company', 'dino', 'dino-app'), { recursive: true });
    mkdirSync(join(root, 'self', 'other'), { recursive: true });
    const service = serviceFor(root);

    const saved = await service.setAlias({ alias: 'dino-datahub', absolutePath: 'company/dino/dino-app', note: 'user wording' });
    expect(saved.created).toBe(true);
    expect(saved.alias).toMatchObject({ alias: 'dino-datahub', note: 'user wording', missing: false });

    const overwritten = await service.setAlias({ alias: 'DINO-DATAHUB', absolutePath: join(root, 'self', 'other') });
    expect(overwritten.created).toBe(false);
    expect(overwritten.alias.note).toBeNull();

    const all = await service.listAliases();
    expect(all).toMatchObject({ total: 1, count: 1, error: null });
    expect(all.aliases[0]!.absolutePath).toBe(join(root, 'self', 'other'));
    expect((await service.listAliases('other')).count).toBe(1);
    expect((await service.listAliases('nothing-here')).count).toBe(0);

    const removed = await service.removeAlias('Dino-Datahub');
    expect(removed.deleted).toBe(true);
    expect(removed.alias).toBe('DINO-DATAHUB');
    expect((await service.listAliases()).total).toBe(0);
    await expect(service.removeAlias('dino-datahub')).rejects.toThrow(/No saved alias/);
  });

  it('keeps searching after the alias file is damaged and repairs it on the next write', async () => {
    const root = tempRoot();
    createRepo(join(root, 'self', 'alpha'));
    mkdirSync(join(root, 'company', 'dino', 'dino-app'), { recursive: true });
    const dataDirectory = tempRoot();
    const service = serviceFor(root, dataDirectory);
    writeFileSync(join(dataDirectory, 'local-project-aliases.json'), '{"aliases":', 'utf8');

    const degraded = await service.search('alpha');
    expect(degraded.results.map((item) => item.directoryName)).toEqual(['alpha']);
    expect(degraded.aliasCount).toBe(0);
    expect(degraded.aliasFileError).toContain('not valid JSON');

    await service.setAlias({ alias: 'dino-datahub', absolutePath: 'company/dino/dino-app' });
    const aliasHit = await service.search('dino-datahub');
    expect(aliasHit.results[0]).toMatchObject({ matchedVia: 'alias', alias: 'dino-datahub', missing: false });
    expect(aliasHit.aliasFileError).toBeNull();
  });

  it('returns the alias target first, marks a missing target and falls back after removal', async () => {
    const root = tempRoot();
    // The spoken name also exists as a different repository, so plain metadata matching would
    // return the wrong checkout without the alias.
    createRepo(join(root, 'self', 'dino-datahub'));
    createRepo(join(root, 'company', 'dino', 'dino-app'));
    const service = serviceFor(root);

    await service.setAlias({ alias: 'dino-datahub', absolutePath: 'company/dino/dino-app' });
    const aliased = await service.search('  Dino-DataHub  ');
    expect(aliased.results[0]).toMatchObject({
      absolutePath: join(root, 'company', 'dino', 'dino-app'),
      matchedVia: 'alias',
      alias: 'dino-datahub',
      missing: false,
      category: 'company',
    });
    expect(aliased.results[0]!.score).toBe(2000);
    // The metadata-only checkout remains an ordinary, lower-ranked result.
    expect(aliased.results.some((item) => item.absolutePath === join(root, 'self', 'dino-datahub') && item.matchedVia === 'metadata')).toBe(true);

    rmSync(join(root, 'company', 'dino', 'dino-app'), { recursive: true, force: true });
    const stale = await service.search('dino-datahub');
    expect(stale.results[0]).toMatchObject({ matchedVia: 'alias', missing: true });
    expect(stale.results[0]!.note).toContain('no longer exists');
    expect(stale.results[0]!.matchReasons.join(' ')).toContain('path missing');

    await service.removeAlias('dino-datahub');
    const removed = await service.search('dino-datahub');
    expect(removed.results[0]).toMatchObject({ absolutePath: join(root, 'self', 'dino-datahub'), matchedVia: 'metadata' });
    expect(removed.results[0]!.score).toBe(1000);
  });
});
