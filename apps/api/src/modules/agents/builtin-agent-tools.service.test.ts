import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuiltinAgentToolsService } from './builtin-agent-tools.service';
import type { CommandsService } from '../commands/commands.service';

describe('built-in glob', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'worklite-glob-'));
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('matches project-relative and absolute path patterns while respecting ignored directories', async () => {
    mkdirSync(join(cwd, '.git'));
    mkdirSync(join(cwd, 'apps', 'web'), { recursive: true });
    mkdirSync(join(cwd, 'node_modules', 'ignored'), { recursive: true });
    writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(cwd, 'apps', 'web', 'package.json'), '{}');
    writeFileSync(join(cwd, 'node_modules', 'ignored', 'package.json'), '{}');
    const createWithReservation = vi.fn(async (command: string) => ({ command }));
    const service = new BuiltinAgentToolsService({ createWithReservation } as unknown as CommandsService);
    for (const pattern of ['apps/*/package.json', './apps/*/package.json', join(cwd, 'apps/*/package.json')]) {
      await service.start('glob', { pattern }, { cwd });
      const command = createWithReservation.mock.lastCall![0];
      expect(execSync(command, { cwd, encoding: 'utf8' }).trim()).toBe('apps/web/package.json');
    }
    await service.start('glob', { pattern: '**/package.json' }, { cwd });
    expect(execSync(createWithReservation.mock.lastCall![0], { cwd, encoding: 'utf8' }).trim()).toBe('apps/web/package.json');
    await service.start('glob', { pattern: 'missing/*.ts' }, { cwd });
    expect(execSync(createWithReservation.mock.lastCall![0], { cwd, encoding: 'utf8' })).toBe('');
    await expect(service.start('glob', { pattern: '/outside/*.ts' }, { cwd })).rejects.toThrow('inside the project');
  });
});

describe('built-in read and grep', () => {
  it('reads inclusive line ranges and combines grep alternatives without changing whole-file reads', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'worklite-read-'));
    try {
      writeFileSync(join(cwd, "example's.txt"), 'alpha\nbeta\ngamma\n');
      const createWithReservation = vi.fn(async (command: string) => ({ command }));
      const service = new BuiltinAgentToolsService({ createWithReservation } as unknown as CommandsService);
      const run = async (name: string, input: object) => {
        await service.start(name, input, { cwd });
        return execSync(createWithReservation.mock.lastCall![0], { cwd, encoding: 'utf8' });
      };
      expect(await run('read', { path: "example's.txt" })).toBe('alpha\nbeta\ngamma\n');
      expect(await run('read', { path: "example's.txt", startLine: 2, endLine: 3 })).toBe('2: beta\n3: gamma');
      expect(await run('read', { path: "example's.txt", endLine: 1 })).toBe('1: alpha');
      expect(await run('grep', { pattern: 'alpha|gamma', path: "example's.txt" })).toBe('1:alpha\n3:gamma\n');
      await expect(service.start('read', { path: 'x', startLine: 3, endLine: 2 }, { cwd })).rejects.toThrow('endLine');
      await expect(service.start('read', { path: 'x', startLine: 0 }, { cwd })).rejects.toThrow('startLine');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('bounds unranged reads and oversized greps only when output limits are given', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'worklite-bounded-'));
    try {
      writeFileSync(join(cwd, 'small.txt'), 'one\ntwo\n');
      writeFileSync(join(cwd, 'large.txt'), Array.from({ length: 10 }, (_, index) => `match ${index + 1}`).join('\n') + '\n');
      writeFileSync(join(cwd, 'other.txt'), 'match a\n');
      const createWithReservation = vi.fn(async (command: string) => ({ command }));
      const service = new BuiltinAgentToolsService({ createWithReservation } as unknown as CommandsService);
      const outputLimits = { readLines: 3, grepLines: 4 };
      const run = (name: string, input: object, limited = true) => service.start(name, input, { cwd, ...(limited ? { outputLimits } : {}) })
        .then(() => execSync(createWithReservation.mock.lastCall![0], { cwd, encoding: 'utf8', shell: '/bin/sh' }));

      expect(await run('read', { path: 'small.txt' })).toBe('one\ntwo\n');
      expect(await run('read', { path: 'large.txt' })).toBe('1: match 1\n2: match 2\n3: match 3\n[Showing lines 1-3 of 10. Read further with startLine and endLine.]');
      expect(await run('read', { path: 'large.txt', startLine: 9 })).toBe('9: match 9\n10: match 10');
      expect(await run('read', { path: 'large.txt' }, false)).toContain('match 10');

      expect(await run('grep', { pattern: 'match a', path: '.' })).toBe('./other.txt:1:match a\n');
      expect(await run('grep', { pattern: 'match', path: '.' })).toBe('[11 matching lines exceed the 4-line limit. Matches per file follow; narrow the path or pattern.]\n./large.txt:10\n./other.txt:1\n');
      await expect(run('grep', { pattern: 'absent', path: '.' })).rejects.toMatchObject({ status: 1 });
      expect((await run('grep', { pattern: 'match', path: '.' }, false)).trim().split('\n')).toHaveLength(11);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
