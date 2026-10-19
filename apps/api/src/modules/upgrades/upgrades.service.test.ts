import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpgradesService } from './upgrades.service';

const JOB_ID = 'upgrade_abc123';

function stateDirectory(phase: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'worklite-upgrades-test-'));
  writeFileSync(join(directory, 'current.json'), JSON.stringify({ projectRoot: '/tmp/worklite' }));
  mkdirSync(join(directory, 'upgrades'));
  writeFileSync(join(directory, 'upgrades', `${JOB_ID}.json`), JSON.stringify({
    id: JOB_ID, phase, releaseHash: 'abc123', releaseDirectory: '/tmp/worklite-release', summary: 'test',
    workspaceId: 'workspace_personal', submissionId: 'sub', executionId: 'exec', token: 'tok',
    pausedTeams: [], pausedWorkflows: [], updatedAt: new Date().toISOString(),
  }));
  return directory;
}

describe('UpgradesService.complete', () => {
  let directory = '';

  afterEach(() => {
    delete process.env.WORKLITE_RUNTIME_STATE_DIR;
    delete process.env.WORKLITE_RELEASE_ROOT;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  function setup(phase: string, transports: Record<string, unknown>): UpgradesService {
    directory = stateDirectory(phase);
    process.env.WORKLITE_RUNTIME_STATE_DIR = directory;
    process.env.WORKLITE_RELEASE_ROOT = '/tmp/worklite';
    const modules = { get: vi.fn((token: string) => transports[token]) };
    return new UpgradesService({} as never, modules as never);
  }

  it('reconnects Feishu and WeChat after a succeeded upgrade', async () => {
    const feishu = { connect: vi.fn(async () => undefined) };
    const wechat = { connect: vi.fn(async () => undefined) };
    const service = setup('succeeded', { FEISHU_UPGRADE_TRANSPORT: feishu, WECHAT_UPGRADE_TRANSPORT: wechat });
    await expect(service.complete(JOB_ID)).resolves.toEqual({ connected: true });
    expect(feishu.connect).toHaveBeenCalledOnce();
    expect(wechat.connect).toHaveBeenCalledOnce();
  });

  it('isolates a WeChat reconnect failure from upgrade completion', async () => {
    const feishu = { connect: vi.fn(async () => undefined) };
    const wechat = { connect: vi.fn(async () => { throw new Error('ilink unreachable'); }) };
    const service = setup('succeeded', { FEISHU_UPGRADE_TRANSPORT: feishu, WECHAT_UPGRADE_TRANSPORT: wechat });
    await expect(service.complete(JOB_ID)).resolves.toEqual({ connected: true });
    expect(wechat.connect).toHaveBeenCalledOnce();
  });
});
