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
