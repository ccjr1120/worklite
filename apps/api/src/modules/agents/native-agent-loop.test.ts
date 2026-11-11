import { describe, expect, it, vi } from 'vitest';
import { NativeAgentLoop, type NativeToolJob } from './native-agent-loop';
import { nativeToolPolicy } from './native-tool-policy';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const signal = () => new AbortController().signal;

describe('native loop scheduling and lifecycle', () => {
  it('runs independent resources concurrently, locks the same resource across batches and preserves hooks', async () => {
    const loop = new NativeAgentLoop();
    const first = deferred();
    const events: string[] = [];
    const job = (id: string, resource: string, gate?: Promise<void>): NativeToolJob => ({ id, policy: { resourceKeys: [resource] }, execute: async (_signal, progress) => { events.push(id); await progress(id); await gate; } });
    const hooks = { beforeTool: async (job: NativeToolJob) => { events.push(`before:${job.id}`); }, afterTool: async (job: NativeToolJob) => { events.push(`after:${job.id}`); }, onProgress: async (job: NativeToolJob) => { events.push(`progress:${job.id}`); } };
    const a = loop.toolBatch([job('a', 'same', first.promise)], signal(), hooks);
    const b = loop.toolBatch([job('b', 'same'), job('c', 'different')], signal(), hooks);
    await vi.waitFor(() => expect(events).toContain('c'));
    expect(events).not.toContain('b');
    first.resolve();
    await Promise.all([a, b]);
    expect(events.indexOf('after:a')).toBeLessThan(events.indexOf('before:b'));
    expect(events.indexOf('progress:a')).toBeLessThan(events.indexOf('after:a'));
  });

  it('serializes the whole batch when one tool declares sequential execution', async () => {
    const loop = new NativeAgentLoop();
    const gate = deferred();
    const next = vi.fn();
    const running = loop.toolBatch([
      { id: 'first', policy: { mode: 'sequential' }, execute: () => gate.promise },
      { id: 'next', policy: { mode: 'parallel' }, execute: async () => { next(); } },
    ], signal());
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
    gate.resolve();
    await running;
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('cancelled lock waiters neither execute nor let later jobs overtake their predecessor', async () => {
    const loop = new NativeAgentLoop();
    const gate = deferred();
    const controller = new AbortController();
    const cancelled = vi.fn();
    const last = vi.fn();
    const first = loop.toolBatch([{ id: 'first', policy: { resourceKeys: ['x'] }, execute: () => gate.promise }], signal());
    const second = loop.toolBatch([{ id: 'cancelled', policy: { resourceKeys: ['x'] }, execute: async () => { cancelled(); } }], controller.signal).catch((error) => error);
    controller.abort();
    await second;
    const third = loop.toolBatch([{ id: 'last', policy: { resourceKeys: ['x'] }, execute: async () => { last(); } }], signal());
    await Promise.resolve();
    expect(cancelled).not.toHaveBeenCalled();
    expect(last).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([first, third]);
    expect(last).toHaveBeenCalledTimes(1);
  });

  it('awaits model preparation and finalization, including errors', async () => {
    const loop = new NativeAgentLoop();
    const events: string[] = [];
    await loop.modelStep(async () => { events.push('model'); return 'ok'; }, {
      prepareRequest: async () => { events.push('prepare'); }, afterResponse: async () => { events.push('response'); }, finishStep: async () => { events.push('finish'); },
    });
    expect(events).toEqual(['prepare', 'model', 'response', 'finish']);
    const failure = new Error('failed');
    const finishStep = vi.fn();
    await expect(loop.modelStep(async () => { throw failure; }, { finishStep })).rejects.toBe(failure);
    expect(finishStep).toHaveBeenCalledWith(failure);
  });

  it('resolves resource identities across tool names while retaining explicit policies', () => {
    expect(nativeToolPolicy('w', 'update_agent', { agentId: 'a' })).toEqual(nativeToolPolicy('w', 'delete_agent', { agentId: 'a' }));
    expect(nativeToolPolicy('w', 'update_agent', { agentId: 'b' })).not.toEqual(nativeToolPolicy('w', 'update_agent', { agentId: 'a' }));
    expect(nativeToolPolicy('w', 'run_host_command', {})).toEqual({ mode: 'parallel' });
    expect(nativeToolPolicy('w', 'custom', {}, { name: 'custom', description: '', inputSchema: {}, executionMode: 'sequential' }).mode).toBe('sequential');
    expect(nativeToolPolicy('w', 'custom', { id: 'a' }, { name: 'custom', description: '', inputSchema: {}, concurrency: { namespace: 'resource', keyFields: ['id'] } }).resourceKeys).toEqual(['w:resource:["a"]']);
  });
});
