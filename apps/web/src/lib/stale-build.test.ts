import { describe, expect, it, vi } from 'vitest';
import { createStaleBuildCheck, type ReloadMemory } from './stale-build';

function memory(initial: string | null = null): ReloadMemory {
  let value = initial;
  return { get: () => value, set: (version) => { value = version; } };
}

describe('createStaleBuildCheck', () => {
  it('asks for one reload when the server runs another version', async () => {
    const shouldReload = createStaleBuildCheck('0.1.113', async () => '0.1.114', () => 0, memory());
    expect(await shouldReload()).toBe(true);
  });

  it('does not reload again for a release this tab already reloaded for', async () => {
    // The served bundle still reports the old version after a reload; reloading again would loop.
    const shouldReload = createStaleBuildCheck('0.1.113', async () => '0.1.114', () => 0, memory('0.1.114'));
    expect(await shouldReload()).toBe(false);
  });

  it('keeps a current bundle and ignores a server without a version or an unreachable server', async () => {
    expect(await createStaleBuildCheck('0.1.114', async () => '0.1.114', () => 0, memory())()).toBe(false);
    expect(await createStaleBuildCheck('0.1.114', async () => null, () => 0, memory())()).toBe(false);
    expect(await createStaleBuildCheck('0.1.114', async () => { throw new TypeError('fetch failed'); }, () => 0, memory())()).toBe(false);
  });

  it('asks the server at most once per interval', async () => {
    let time = 0;
    const fetchVersion = vi.fn(async () => '0.1.114');
    const shouldReload = createStaleBuildCheck('0.1.114', fetchVersion, () => time, memory());
    await shouldReload();
    time = 10_000;
    await shouldReload();
    expect(fetchVersion).toHaveBeenCalledTimes(1);
    time = 31_000;
    await shouldReload();
    expect(fetchVersion).toHaveBeenCalledTimes(2);
  });
});
