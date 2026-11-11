// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { settleRuntimeInterruption } from './runtime-interruption';

afterEach(() => vi.useRealTimers());

it('releases an unresponsive native interrupt after the cleanup deadline', async () => {
  vi.useFakeTimers();
  let stopped = false;
  const waiting = settleRuntimeInterruption(() => new Promise(() => {})).then(() => { stopped = true; });
  await vi.advanceTimersByTimeAsync(4999);
  expect(stopped).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await waiting;
  expect(stopped).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('releases a failed interrupt without leaking its deadline timer', async () => {
  vi.useFakeTimers();
  await settleRuntimeInterruption(async () => { throw new Error('Engine already stopped'); });
  expect(vi.getTimerCount()).toBe(0);
});
