import { describe, expect, it, vi } from 'vitest';
import { AgentTeamRuntimeService } from './coder-runtime.service';

function runtimeFor(orchestrationVersion: number, targetRole = 'router') {
  return Object.assign(Object.create(AgentTeamRuntimeService.prototype), {
    getRun: vi.fn().mockResolvedValue({ id: 'run', groupContext: { targetRole } }),
    getVersion: vi.fn().mockResolvedValue({ snapshot: { orchestrationVersion } }),
  }) as AgentTeamRuntimeService;
}

describe('Router Run version guard', () => {
  it('allows controls only on v12 Router Runs', async () => {
    await expect(runtimeFor(12).assertRouterRun('run')).resolves.toBeUndefined();
    await expect(runtimeFor(11).assertRouterRun('run')).rejects.toThrow('available only for v12 Router-coordinated Runs');
    await expect(runtimeFor(12, 'planner').assertRouterRun('run')).rejects.toThrow('available only for v12 Router-coordinated Runs');
  });

  it('rejects answers and operation recovery for retired Runs before touching inputs', async () => {
    const runtime = runtimeFor(11);
    await expect(runtime.answer('run', {} as never)).rejects.toThrow('available only for v12 Router-coordinated Runs');
    await expect(runtime.recover('run', {} as never)).rejects.toThrow('available only for v12 Router-coordinated Runs');
  });
});
