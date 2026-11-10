// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacosNotificationHelper } from './macos-notification-helper';

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const base = resolve('.data/notification-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-'));
  directories.push(root);
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts/macos-notifications.swift'), 'import AppKit');
  vi.stubEnv('WORKLITE_RELEASE_ROOT', root);
  vi.stubEnv('SQLITE_PATH', join(root, 'state/worklite.db'));
  const command = vi.fn(async (executable: string, args: string[]) => {
    if (executable === '/usr/bin/xcrun') await writeFile(args[args.indexOf('-o') + 1]!, 'native-binary');
    return '{}';
  });
  return { root, command, helper: new MacosNotificationHelper(command) };
}

describe('stable macOS notification helper', () => {
  it('installs, signs and registers one stable app, coalescing concurrent initialization', async () => {
    const { helper, command } = await fixture();
    const [first, second] = await Promise.all([helper.prepare(), helper.prepare()]);
    expect(first).toEqual(second);
    expect(command).toHaveBeenCalledTimes(3);
    expect(await readFile(join(first.directory, 'WorkLite Notifications.app/Contents/Info.plist'), 'utf8')).toContain('com.worklite.notifications');
    await new MacosNotificationHelper(command).prepare();
    expect(command).toHaveBeenCalledTimes(3);
  });
  it('repairs a missing helper and rebuilds when captured source changes', async () => {
    const { helper, root, command } = await fixture();
    const first = await helper.prepare();
    await rm(first.executable);
    await new MacosNotificationHelper(command).prepare();
    expect(command).toHaveBeenCalledTimes(6);
    await writeFile(join(root, 'scripts/macos-notifications.swift'), 'import AppKit\n// upgraded');
    await new MacosNotificationHelper(command).prepare();
    expect(command).toHaveBeenCalledTimes(9);
  });
  it('persists each setup guide once across API restarts', async () => {
    const { helper, command } = await fixture();
    await helper.guide('focus');
    await new MacosNotificationHelper(command).guide('focus');
    expect(command.mock.calls.filter(([, args]) => args[0] === '--guide')).toHaveLength(1);
    await helper.guide('authorization');
    expect(command.mock.calls.filter(([, args]) => args[0] === '--guide')).toHaveLength(2);
  });
  it('retries installation after a compiler failure', async () => {
    const { helper, command } = await fixture();
    command.mockRejectedValueOnce(new Error('compiler failed'));
    await expect(helper.prepare()).rejects.toThrow('compiler failed');
    await expect(helper.prepare()).resolves.toHaveProperty('executable');
  });
});
