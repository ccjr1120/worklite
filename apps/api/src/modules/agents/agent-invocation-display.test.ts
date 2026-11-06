import { describe, expect, it } from 'vitest';
import { agentInvocationDisplays } from './agent-invocation-display';

describe('Chat Agent invocation mentions', () => {
  it.each(['running', 'waiting_for_input', 'completed', 'failed', 'cancelled'] as const)('reads the actual %s background execution independently of the launch receipt', (status) => {
    const calls = [{ id: 'dispatch', mcpToolName: 'run_agent', input: { agentId: 'agent', __agentName: 'qcoder', __backgroundExecutionId: 'background', __agentInvocationId: 'air_run' }, createdAt: new Date() }];
    expect(agentInvocationDisplays(calls, [], [], [{ id: 'background', status, phase: 'model' }]).get('dispatch')?.status).toBe(status);
  });

  it.each(['paused', 'waiting_for_input', 'completed', 'failed', 'cancelled'] as const)('retains the recorded %s state of historical inline invocations', (status) => {
    const calls = [{ id: 'dispatch', mcpToolName: 'run_agent', input: { agentId: 'agent', __agentInvocationId: 'air_old' }, createdAt: new Date() }];
    const rows = [{ id: 'air_old', metadata: { agentId: 'agent', agentName: 'qcoder', status } }];
    expect(agentInvocationDisplays(calls, rows, []).get('dispatch')?.status).toBe(status);
  });

  it.each(['failed', 'cancelled'] as const)('settles stale historical invocations when their owning execution is %s', (status) => {
    const calls = [{ id: 'dispatch', mcpToolName: 'run_agent', input: { agentId: 'agent', __agentInvocationId: 'air_old' }, createdAt: new Date() }];
    const rows = [{ id: 'air_old', metadata: { agentId: 'agent', agentName: 'qcoder', status: 'running' } }];
    expect(agentInvocationDisplays(calls, rows, [], [], status).get('dispatch')?.status).toBe(status);
  });

  it('uses the background execution state instead of the completed launch tool state', () => {
    const calls = [{ id: 'dispatch', mcpToolName: 'run_agent', input: { agentId: 'agent', task: '修复任务卡片', __agentName: 'qcoder', __backgroundExecutionId: 'background', __agentInvocationId: 'air_run' }, createdAt: new Date() }];
    const backgrounds = [{ id: 'background', status: 'running' as const, phase: 'skill' as const }];
    expect(agentInvocationDisplays(calls, [], [], backgrounds).get('dispatch')).toMatchObject({ task: '修复任务卡片', status: 'running', phase: 'skill' });
    expect(agentInvocationDisplays(calls, [], [], [{ ...backgrounds[0]!, status: 'completed' }]).get('dispatch')?.status).toBe('completed');
  });

  it('links a background launch to its independent run before a result is available', () => {
    const calls = [{ id: 'dispatch', mcpToolName: 'run_agent', input: { agentId: 'agent', __agentName: 'qcoder', __backgroundExecutionId: 'aex_background', __agentInvocationId: 'air_background' }, createdAt: new Date() }];
    expect(agentInvocationDisplays(calls, [], []).get('dispatch')).toEqual({ agentId: 'agent', agentName: 'qcoder', runId: 'air_background', task: '' });
  });

  const call = { id: 'call', mcpToolName: 'run_agent', input: { agentId: 'agent' }, createdAt: new Date('2026-11-04T00:00:00Z') };
  it('recovers the exact root invocation for historical calls, excluding sub-Agents', () => {
    const rows = [
      { id: 'child', metadata: { agentId: 'agent', parentRunId: 'root', agentName: 'Child', createdAt: '2026-11-04T00:00:00.010Z' } },
      { id: 'root', metadata: { agentId: 'agent', parentRunId: null, agentName: 'qcoder', createdAt: '2026-11-04T00:00:00.020Z' } },
    ];
    expect(agentInvocationDisplays([call], rows, []).get('call')).toEqual({ agentId: 'agent', agentName: 'qcoder', runId: 'root', task: '' });
  });
  it('does not bind an earlier call to a later dispatch of the same Agent', () => {
    const second = { ...call, id: 'second', createdAt: new Date('2026-11-04T00:00:01Z') };
    const rows = [{ id: 'later', metadata: { agentId: 'agent', agentName: 'qcoder', createdAt: '2026-11-04T00:00:01.100Z' } }];
    const result = agentInvocationDisplays([call, second], rows, [{ id: 'agent', name: 'qcoder' }]);
    expect(result.get('call')?.runId).toBe('call');
    expect(result.get('second')?.runId).toBe('later');
  });
  it('prefers the explicit binding and keeps the original Agent name after rename', () => {
    const rows = [{ id: 'bound', metadata: { agentId: 'agent', agentName: 'Original' } }];
    const result = agentInvocationDisplays([{ ...call, input: { agentId: 'agent', __agentInvocationId: 'bound' } }], rows, [{ id: 'agent', name: 'Renamed' }]);
    expect(result.get('call')).toEqual({ agentId: 'agent', agentName: 'Original', runId: 'bound', task: '' });
  });
});
