import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamBatch } from './stream-batch';
afterEach(() => vi.useRealTimers());
describe('stream coalescing', () => {
  it('preserves all Unicode text and interleaved stream ordering with far fewer writes', async () => {
    const written: Array<{ type: string; text: string }> = [];
    const batch = new StreamBatch(
      async (value: { type: string; text: string }) => {
        written.push(value);
      },
      (a, b) => (a.type === b.type ? { ...a, text: a.text + b.text } : undefined),
      (v) => Buffer.byteLength(v.text),
    );
    for (let i = 0; i < 500; i++) batch.push({ type: 'stdout', text: '中文🦊' });
    batch.push({ type: 'stderr', text: 'error' });
    batch.push({ type: 'stdout', text: 'end' });
    await batch.flush();
    expect(written).toEqual([
      { type: 'stdout', text: '中文🦊'.repeat(500) },
      { type: 'stderr', text: 'error' },
      { type: 'stdout', text: 'end' },
    ]);
  });
  it('flushes on the delay and propagates persistence failures at the barrier', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {
      throw new Error('disk full');
    });
    const batch = new StreamBatch(
      write,
      (a: string, b: string) => a + b,
      (v) => v.length,
    );
    batch.push('first');
    await vi.advanceTimersByTimeAsync(50);
    expect(write).toHaveBeenCalledOnce();
    await expect(batch.flush()).rejects.toThrow('disk full');
  });
});
