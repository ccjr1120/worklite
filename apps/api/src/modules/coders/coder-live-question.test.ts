import { describe, expect, it, vi } from 'vitest';
import { AgentTeamRuntimeService } from './coder-runtime.service';

// A Claude AskUserQuestion in a Coder role keeps its executor session parked: the question is
// persisted as a pending input, and answering it resolves the wait instead of resuming a graph.
describe('Coder live Claude questions', () => {
  function runtime() {
    const finishWaitingAttempt = vi.fn(async () => ({ status: 'waiting_for_input', pendingInput: { id: 'atinput_1', question: 'Which approach?', scopeRevision: 1 } }));
    const setRunStatus = vi.fn(async () => undefined);
    const service = Object.assign(Object.create(AgentTeamRuntimeService.prototype), {
      liveQuestions: new Map(),
      finishWaitingAttempt,
      setRunStatus,
    });
    const wait = Reflect.get(AgentTeamRuntimeService.prototype, 'waitForLiveAnswer') as (...args: unknown[]) => Promise<string | undefined>;
    const release = Reflect.get(AgentTeamRuntimeService.prototype, 'releaseLiveQuestions') as (runId?: string) => void;
    const request = { runId: 'run', scopeRevision: 1, taskDefinition: { role: 'implementer', taskKey: 'task' } };
    return { service, finishWaitingAttempt, setRunStatus, wait: (signal: AbortSignal) => wait.call(service, request, 'workspace', 'attempt', 'Which approach?', signal), release: (runId?: string) => release.call(service, runId) };
  }

  it('persists the question as a live wait and resolves with the delivered answer', async () => {
    const { service, finishWaitingAttempt, setRunStatus, wait } = runtime();
    const answer = wait(new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finishWaitingAttempt).toHaveBeenCalledWith(expect.anything(), 'workspace', 'attempt', expect.objectContaining({ status: 'waiting_for_input' }), true);
    expect(setRunStatus).toHaveBeenCalledWith('run', 'waiting_for_input');
    const live = service.liveQuestions.get('atinput_1');
    expect(live?.runId).toBe('run');
    service.liveQuestions.delete('atinput_1');
    live.resolve('A');
    await expect(answer).resolves.toBe('A');
  });

  it('ends the wait with no answer on abort or when the run is cancelled', async () => {
    const aborted = runtime();
    const controller = new AbortController();
    const first = aborted.wait(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(first).resolves.toBeUndefined();
    expect(aborted.service.liveQuestions.size).toBe(0);

    const cancelled = runtime();
    const second = cancelled.wait(new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    cancelled.release('other-run');
    expect(cancelled.service.liveQuestions.size).toBe(1);
    cancelled.release('run');
    await expect(second).resolves.toBeUndefined();
    expect(cancelled.service.liveQuestions.size).toBe(0);
  });
});
