import { describe, expect, it, vi } from 'vitest';
import { SubAgentInstance } from './sub-agent-instance';

const blocked = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  if (signal.aborted) reject(signal.reason);
});

describe('Sub-Agent instance lifecycle', () => {
  it('rejects unsafe pause before an engine session is saved and cancels a parked instance with its owner', async () => {
    const owner = new AbortController();
    const changed = vi.fn();
    const execute = vi.fn(blocked);
    const instance = new SubAgentInstance('workspace', 'execution', 'parent', 'im', 'run', owner.signal, execute, changed);
    await expect(instance.pause()).rejects.toThrow('saved a resumable session');
    instance.resumeId = 'engine-session';
    await Promise.all([instance.pause(), instance.pause()]);
    expect(changed).toHaveBeenCalledExactlyOnceWith('paused');
    expect(instance.status).toBe('paused');
    owner.abort(new Error('Owner cancelled'));
    await expect(instance.done).rejects.toThrow('Owner cancelled');
    expect(instance.status).toBe('cancelled');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(() => instance.resume()).toThrow('Only a paused');
  });

  it('handles completion racing a pause without parking a finished instance', async () => {
    let finish!: (result: string) => void;
    const instance = new SubAgentInstance('workspace', 'execution', 'parent', 'im', 'run', new AbortController().signal, () => new Promise<string>((resolve) => { finish = resolve; }), vi.fn());
    instance.resumeId = 'session';
    const paused = instance.pause();
    finish('Done');
    await paused;
    await expect(instance.done).resolves.toBe('Done');
    expect(instance.status).toBe('completed');
    expect(() => instance.resume()).toThrow('Only a paused');
  });
});
