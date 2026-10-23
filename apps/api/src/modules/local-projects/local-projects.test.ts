import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyProject,
  repositoryNameFromRemote,
  sanitizeRemoteUrl,
  scanLocalProjects,
  searchProjectRecords,
  tokenize,
  type LocalProjectRecord,
} from './local-projects';
import { LocalProjectsService } from './local-projects.service';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'worklite-local-projects-'));
  roots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function createRepo(path: string, options: { branch?: string; remote?: string | null } = {}): void {
  mkdirSync(join(path, '.git'), { recursive: true });
  writeFileSync(join(path, '.git', 'HEAD'), `ref: refs/heads/${options.branch ?? 'main'}\n`);
  if (options.remote) {
    writeFileSync(join(path, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${options.remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  }
}

function project(overrides: Partial<LocalProjectRecord> = {}): LocalProjectRecord {
  const directoryName = overrides.directoryName ?? 'project';
  return {
    absolutePath: `/development/self/${directoryName}`,
    relativePath: `self/${directoryName}`,
    directoryName,
    repositoryName: directoryName,
    displayName: directoryName,
    description: '',
    readmeTitle: null,
    category: 'self',
    gitRemoteUrl: null,
    branch: 'main',
    isMainWorktree: true,
    workspacePatterns: [],
    ...overrides,
  };
}

describe('scanLocalProjects', () => {
  it('extracts git, manifest and README metadata while skipping noise, hidden and symlinked directories', () => {
    const root = tempRoot();
    const dino = join(root, 'company', 'dino-datahub');
    createRepo(dino, { remote: 'https://oauth2:glpat-secret-token@gitlab.example.com/data/dino-datahub.git' });
    write(join(dino, 'package.json'), JSON.stringify({
      name: '@dino/datahub',
      description: 'Dino data publishing platform',
      workspaces: ['packages/*'],
    }));
    write(join(dino, 'README.md'), '# Dino DataHub\n\nPublishing platform for dino data.\n');
    // Noise inside a repository must not become another project.
    createRepo(join(dino, 'node_modules', 'noise'));
    createRepo(join(dino, '.next', 'build-noise'));

    const plain = join(root, 'self', 'no-remote');
    createRepo(plain, { branch: 'develop' });
    write(join(plain, 'README.md'), '# Plain Project\n\nA plain project.\n');

    const worktree = join(root, 'temp', 'worktree-repo');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: ../worktree-git/worktree-repo\n');
    write(join(root, 'temp', 'worktree-git', 'worktree-repo', 'HEAD'), 'ref: refs/heads/wt-branch\n');

    const outer = join(root, 'other', 'outer');
    createRepo(outer);
    createRepo(join(outer, 'inner'));

    // Hidden directory and a symlink pointing outside the root are both ignored.
    createRepo(join(root, '.cache', 'hidden-repo'));
    const outside = tempRoot();
    createRepo(join(outside, 'linked-repo'));
    symlinkSync(join(outside, 'linked-repo'), join(root, 'self', 'linked-repo'), 'dir');

    const index = scanLocalProjects({ root });

    expect(index.complete).toBe(true);
    expect(index.timedOut).toBe(false);
    expect(index.truncated).toBe(false);
    expect(index.projects.map((item) => item.relativePath)).toEqual([
      'company/dino-datahub',
      'other/outer',
      'other/outer/inner',
      'self/no-remote',
      'temp/worktree-repo',
    ]);

    const dinoRecord = index.projects.find((item) => item.directoryName === 'dino-datahub')!;
    expect(dinoRecord).toMatchObject({
      absolutePath: dino,
      category: 'company',
      repositoryName: 'dino-datahub',
      displayName: '@dino/datahub',
      description: 'Dino data publishing platform',
      readmeTitle: 'Dino DataHub',
      gitRemoteUrl: 'https://gitlab.example.com/data/dino-datahub.git',
      branch: 'main',
      isMainWorktree: true,
      workspacePatterns: ['packages/*'],
    });

    const plainRecord = index.projects.find((item) => item.directoryName === 'no-remote')!;
    expect(plainRecord).toMatchObject({
      category: 'self',
      repositoryName: 'no-remote',
      displayName: 'Plain Project',
      description: 'A plain project.',
      gitRemoteUrl: null,
      branch: 'develop',
    });

    const worktreeRecord = index.projects.find((item) => item.directoryName === 'worktree-repo')!;
    expect(worktreeRecord).toMatchObject({ category: 'temp', branch: 'wt-branch', isMainWorktree: false, gitRemoteUrl: null });

    expect(index.projects.some((item) => item.directoryName === 'noise')).toBe(false);
    expect(index.projects.some((item) => item.directoryName === 'hidden-repo')).toBe(false);
    expect(index.projects.some((item) => item.directoryName === 'linked-repo')).toBe(false);
    expect(index.projects.every((item) => !item.gitRemoteUrl?.includes('glpat-secret-token'))).toBe(true);
  });

  it('stops at the repository and directory caps and marks the result truncated', () => {
    const root = tempRoot();
    createRepo(join(root, 'self', 'one'));
    createRepo(join(root, 'self', 'two'));

    const index = scanLocalProjects({ root, maxRepositories: 1 });
    expect(index.projects).toHaveLength(1);
    expect(index.truncated).toBe(true);
    expect(index.complete).toBe(false);
  });

  it('returns a bounded partial result when the scan deadline has passed', () => {
    const root = tempRoot();
    createRepo(join(root, 'self', 'one'));

    const index = scanLocalProjects({ root, timeoutMs: 0 });
    expect(index.timedOut).toBe(true);
    expect(index.complete).toBe(false);
    expect(index.projects).toEqual([]);
  });

  it('reports a missing root without throwing', () => {
    const root = join(tempRoot(), 'missing');
    const index = scanLocalProjects({ root });
    expect(index.complete).toBe(false);
    expect(index.projects).toEqual([]);
    expect(index.error).toContain('not a readable directory');
  });
});

describe('classifyProject', () => {
  it('classifies by the first path segment of the scan root', () => {
    const root = '/Users/example/development';
    expect(classifyProject(root, '/Users/example/development/company/app')).toBe('company');
    expect(classifyProject(root, '/Users/example/development/self/app')).toBe('self');
    expect(classifyProject(root, '/Users/example/development/temp/work')).toBe('temp');
    expect(classifyProject(root, '/Users/example/development/forks/fork')).toBe('forks');
    expect(classifyProject(root, '/Users/example/development/misc/app')).toBe('other');
    expect(classifyProject(root, '/Users/example/development')).toBe('other');
  });
});

describe('repositoryNameFromRemote', () => {
  it('derives a name from https, ssh and scp-like remotes', () => {
    expect(repositoryNameFromRemote('https://gitlab.example.com/data/dino-datahub.git')).toBe('dino-datahub');
    expect(repositoryNameFromRemote('ssh://git@host/team/repo.git/')).toBe('repo');
    expect(repositoryNameFromRemote('git@github.com:team/repo.git')).toBe('repo');
    expect(repositoryNameFromRemote(null)).toBeNull();
  });

  it('strips embedded credentials while keeping ordinary ssh remotes', () => {
    expect(sanitizeRemoteUrl('https://oauth2:glpat-secret@gitlab.example.com/data/repo.git')).toBe('https://gitlab.example.com/data/repo.git');
    expect(sanitizeRemoteUrl('https://user@gitlab.example.com/data/repo.git')).toBe('https://gitlab.example.com/data/repo.git');
    expect(sanitizeRemoteUrl('oauth2:glpat-secret@gitlab.example.com:data/repo.git')).toBe('gitlab.example.com:data/repo.git');
    expect(sanitizeRemoteUrl('git@github.com:team/repo.git')).toBe('git@github.com:team/repo.git');
  });
});

describe('searchProjectRecords', () => {
  const projects = [
    project({ directoryName: 'dino', repositoryName: 'dino', displayName: 'dino', category: 'self' }),
    project({ directoryName: 'dino-datahub', repositoryName: 'dino-datahub', displayName: '@dino/datahub', description: 'Dino data publishing platform', category: 'company' }),
    project({ directoryName: 'my-dino-app', repositoryName: 'my-dino-app', displayName: 'my-dino-app' }),
    project({ directoryName: 'platform', repositoryName: 'platform', displayName: '发布平台', description: 'Dino data publishing platform' }),
  ];

  it('ranks exact, prefix, substring and description matches in that order', () => {
    const result = searchProjectRecords(projects, 'dino');
    expect(result.results.map((item) => item.directoryName)).toEqual(['dino', 'dino-datahub', 'my-dino-app', 'platform']);
    expect(result.totalMatched).toBe(4);
    expect(result.results[0]!.matchReasons[0]).toContain('exact match');
    expect(result.results[3]!.matchReasons[0]).toContain('description');
  });

  it('matches case-insensitively and across words', () => {
    expect(searchProjectRecords(projects, 'DATAHUB').results[0]!.directoryName).toBe('dino-datahub');
    expect(searchProjectRecords(projects, '发布平台').results[0]!.directoryName).toBe('platform');
    expect(tokenize('Dino  DATAHUB')).toEqual(['dino', 'datahub']);
  });

  it('requires every query term to match somewhere', () => {
    const result = searchProjectRecords(projects, 'datahub publishing');
    expect(result.results.map((item) => item.directoryName)).toEqual(['dino-datahub']);
  });

  it('honours the limit while reporting the full match count', () => {
    const result = searchProjectRecords(projects, 'dino', 1);
    expect(result.results).toHaveLength(1);
    expect(result.totalMatched).toBe(4);
  });

  it('returns approximate candidates and the indexed count when nothing matches', () => {
    const result = searchProjectRecords(projects, 'dino-dta');
    expect(result.results).toEqual([]);
    expect(result.totalMatched).toBe(0);
    expect(result.indexedProjects).toBe(4);
    expect(result.approximate[0]?.directoryName).toBe('dino-datahub');
    expect(result.approximate[0]!.matchReasons.join(' ')).toContain('approximate');
  });

  it('matches a guessed compound name through its segments', () => {
    const target = project({
      absolutePath: '/development/company/dino/apex-datahub',
      relativePath: 'company/dino/apex-datahub',
      directoryName: 'apex-datahub',
      repositoryName: 'apex-datahub',
      displayName: 'apex-datahub',
      description: 'Apex DataHub',
      category: 'company',
    });
    const result = searchProjectRecords([target], 'dino-datahub');
    expect(result.results.map((item) => item.directoryName)).toEqual(['apex-datahub']);
    expect(result.results[0]!.matchReasons[0]).toContain('segments');
  });

  it('surfaces partial Chinese keyword overlap as an approximate candidate', () => {
    const chinese = [project({ directoryName: 'dino-app', repositoryName: 'dino-app', displayName: 'rex-app', description: '数据标注平台前端项目。' })];
    const result = searchProjectRecords(chinese, '发布平台');
    expect(result.results).toEqual([]);
    expect(result.approximate[0]?.directoryName).toBe('dino-app');
    expect(result.approximate[0]!.matchReasons.join(' ')).toContain('partial keyword overlap');
  });

  it('does not invent approximate candidates for unrelated Latin noise', () => {
    const result = searchProjectRecords(projects, 'zzzz-not-a-project');
    expect(result.results).toEqual([]);
    expect(result.approximate).toEqual([]);
    expect(result.indexedProjects).toBe(4);
  });

  it('reports zero indexed projects for a different unmatched query', () => {
    const result = searchProjectRecords([], 'anything');
    expect(result.results).toEqual([]);
    expect(result.approximate).toEqual([]);
    expect(result.indexedProjects).toBe(0);
  });
});

describe('searchProjectRecords with aliases', () => {
  const root = '/development';
  const projects = [
    project({ directoryName: 'dino-datahub', repositoryName: 'dino-datahub', displayName: 'dino-datahub', category: 'self' }),
    project({
      absolutePath: '/development/company/dino/dino-app',
      relativePath: 'company/dino/dino-app',
      directoryName: 'dino-app',
      repositoryName: 'dino-app',
      displayName: 'dino-datahub',
      category: 'company',
      branch: 'feature/datahub',
      gitRemoteUrl: 'https://gitlab.example.com/data/dino-app.git',
    }),
  ];

  it('puts an exact alias above every metadata match and labels its source', () => {
    const result = searchProjectRecords(projects, '  DINO-DATAHUB  ', 10, {
      root,
      aliases: [{ alias: 'dino-datahub', absolutePath: '/development/company/dino/dino-app', note: 'user wording', missing: false }],
    });
    expect(result.results[0]).toMatchObject({
      absolutePath: '/development/company/dino/dino-app',
      matchedVia: 'alias',
      alias: 'dino-datahub',
      note: 'user wording',
      score: 2000,
      branch: 'feature/datahub',
    });
    expect(result.results[0]!.matchReasons).toContain('alias: "dino-datahub"');
    expect(result.totalMatched).toBe(2);
  });

  it('merges an alias with the metadata match for the same path and keeps both reasons', () => {
    const result = searchProjectRecords(projects, 'dino-datahub', 10, {
      root,
      aliases: [{ alias: 'dino-datahub', absolutePath: '/development/company/dino/dino-app', note: null, missing: false }],
    });
    const matches = result.results.filter((item) => item.absolutePath === '/development/company/dino/dino-app');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.matchedVia).toBe('alias');
    expect(matches[0]!.matchReasons.join(' ')).toContain('displayName: exact');
    expect(result.totalMatched).toBe(2);
  });

  it('returns a non-Git alias target with inferred category and empty Git fields', () => {
    const result = searchProjectRecords([], '数据平台', 10, {
      root,
      aliases: [{ alias: '数据平台', absolutePath: '/development/company/team/plain-dir', note: null, missing: false }],
    });
    expect(result.results[0]).toMatchObject({
      absolutePath: '/development/company/team/plain-dir',
      directoryName: 'plain-dir',
      category: 'company',
      branch: null,
      gitRemoteUrl: null,
      matchedVia: 'alias',
    });
  });

  it('flags a stale alias target and explains it in the note', () => {
    const result = searchProjectRecords([], 'dino-datahub', 10, {
      root,
      aliases: [{ alias: 'dino-datahub', absolutePath: '/development/company/dino/dino-app', note: 'old checkout', missing: true }],
    });
    expect(result.results[0]).toMatchObject({ matchedVia: 'alias', missing: true });
    expect(result.results[0]!.note).toContain('no longer exists');
    expect(result.results[0]!.note).toContain('old checkout');
    expect(result.results[0]!.matchReasons).toContain('path missing: /development/company/dino/dino-app');
  });

  it('matches aliases fuzzily above metadata fields', () => {
    const result = searchProjectRecords(projects, 'dino-data', 10, {
      root,
      aliases: [{ alias: 'dino-datahub', absolutePath: '/development/company/dino/dino-app', note: null, missing: false }],
    });
    expect(result.results[0]).toMatchObject({ matchedVia: 'alias', score: 1700 });
  });

  it('includes alias candidates in approximate results when nothing matches exactly', () => {
    const result = searchProjectRecords([], 'dino-dta', 10, {
      root,
      aliases: [{ alias: 'dino-datahub', absolutePath: '/development/company/dino/dino-app', note: null, missing: false }],
    });
    expect(result.results).toEqual([]);
    expect(result.approximate[0]).toMatchObject({ matchedVia: 'alias', alias: 'dino-datahub' });
    expect(result.approximate[0]!.matchReasons.join(' ')).toContain('alias:');
  });

  it('keeps multiple aliases for one path as a single result with both reasons', () => {
    const result = searchProjectRecords([], 'dino', 10, {
      root,
      aliases: [
        { alias: 'dino-datahub', absolutePath: '/development/company/dino/dino-app', note: null, missing: false },
        { alias: 'dino-data', absolutePath: '/development/company/dino/dino-app', note: 'same checkout', missing: false },
      ],
    });
    expect(result.results).toHaveLength(1);
    expect(result.totalMatched).toBe(1);
    expect(result.results[0]!.matchReasons.join(' ')).toContain('alias: "dino-datahub"');
    expect(result.results[0]!.matchReasons.join(' ')).toContain('alias: "dino-data"');
  });
});

describe('LocalProjectsService', () => {
  function config(values: Record<string, string>): ConfigService {
    return { get: (key: string) => values[key] } as unknown as ConfigService;
  }

  it('scans lazily, persists the index and refreshes only when asked', async () => {
    const root = tempRoot();
    const indexDirectory = tempRoot();
    createRepo(join(root, 'self', 'alpha'));
    const service = new LocalProjectsService(config({
      WORKLITE_LOCAL_PROJECTS_ROOT: root,
      WORKLITE_LOCAL_PROJECTS_INDEX_PATH: join(indexDirectory, 'local-projects.json'),
    }));

    const first = await service.search('alpha');
    expect(first.results.map((item) => item.directoryName)).toEqual(['alpha']);
    expect(first.stale).toBe(false);
    expect(first.indexedProjects).toBe(1);
    expect(first.note).toBeNull();

    createRepo(join(root, 'self', 'beta'));
    const cached = await service.search('beta');
    expect(cached.results).toEqual([]);
    expect(cached.indexedProjects).toBe(1);

    const refreshed = await service.search('beta', { refresh: true });
    expect(refreshed.results.map((item) => item.directoryName)).toEqual(['beta']);
    expect(refreshed.indexedProjects).toBe(2);

    const status = await service.status();
    expect(status.updatedAt).not.toBeNull();
    expect(status.complete).toBe(true);
    expect(status.indexedProjects).toBe(2);
  });

  it('derives the index cache path from the runtime data directory', async () => {
    const root = tempRoot();
    createRepo(join(root, 'self', 'alpha'));
    const dataDirectory = tempRoot();
    const service = new LocalProjectsService(config({
      WORKLITE_LOCAL_PROJECTS_ROOT: root,
      WORKLITE_DATA_DIRECTORY: dataDirectory,
    }));

    const status = await service.status();
    expect(status.indexPath).toBe(join(dataDirectory, 'local-projects.json'));
  });

  it('rejects an empty query', async () => {
    const service = new LocalProjectsService(config({ WORKLITE_LOCAL_PROJECTS_ROOT: tempRoot() }));
    await expect(service.search('   ')).rejects.toThrow('query must be a non-empty');
  });
});
