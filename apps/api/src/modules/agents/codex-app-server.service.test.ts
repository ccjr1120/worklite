import { describe, expect, it } from 'vitest';
import { CodexAppServerService } from './codex-app-server.service';

describe('CodexAppServerService.captureLaunch', () => {
  const service = new CodexAppServerService({} as never);

  it('accepts a bare alias command word and keeps the configured model', async () => {
    const launch = await service.captureLaunch(['cxo'], 'gpt-6-luna');
    expect(launch).toEqual({ executor: 'codex', commandArguments: ['cxo'], model: 'gpt-6-luna' });
  });

  it('keeps a null model so Codex resolves its own configured default', async () => {
    const launch = await service.captureLaunch(['cx'], null);
    expect(launch.model).toBeNull();
  });

  it('keeps additional fixed arguments after the command word', async () => {
    const launch = await service.captureLaunch(['codex', '--some-flag'], null);
    expect(launch.commandArguments).toEqual(['codex', '--some-flag']);
  });

  it('rejects an empty command', async () => {
    await expect(service.captureLaunch([], null)).rejects.toThrow('A Codex command is required');
  });

  it('rejects a command word containing shell metacharacters', async () => {
    await expect(service.captureLaunch(['codex; rm -rf /'], null)).rejects.toThrow('without shell syntax');
    await expect(service.captureLaunch(['codex && echo hi'], null)).rejects.toThrow('without shell syntax');
    await expect(service.captureLaunch(['codex`whoami`'], null)).rejects.toThrow('without shell syntax');
  });

  it('accepts a path-like command word', async () => {
    const launch = await service.captureLaunch(['/usr/local/bin/codex'], null);
    expect(launch.commandArguments).toEqual(['/usr/local/bin/codex']);
  });
});
