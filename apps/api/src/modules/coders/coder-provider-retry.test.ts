import { describe, expect, it, vi } from 'vitest';
import { ModelGatewayError } from '@worklite/model-gateway';
import { retryTransientProviderFailure } from './coder-provider-retry';

function providerFailure(status: number): ModelGatewayError {
  const failure = new ModelGatewayError('PROVIDER_REQUEST_FAILED', `模型服务请求失败（HTTP ${status}）`);
  failure.statusCode = status;
  return failure;
}

describe('retryTransientProviderFailure', () => {
  it('starts a role over after an upstream 502 when no model call had finished', async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(providerFailure(502))
      .mockRejectedValueOnce(providerFailure(502))
      .mockResolvedValueOnce('{"status":"completed"}');
    const onRetry = vi.fn();
    await expect(retryTransientProviderFailure({ invoke, nothingRan: () => true, signal: new AbortController().signal, onRetry, delaysMs: [1, 1] }))
      .resolves.toBe('{"status":"completed"}');
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls.map(([detail]) => detail.retry)).toEqual([1, 2]);
  });

  it('fails once the retries are spent', async () => {
    const invoke = vi.fn().mockRejectedValue(providerFailure(503));
    await expect(retryTransientProviderFailure({ invoke, nothingRan: () => true, signal: new AbortController().signal, onRetry: vi.fn(), delaysMs: [1, 1] }))
      .rejects.toThrow('HTTP 503');
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('does not repeat a role whose tools may already have run, or an exhausted quota', async () => {
    const afterTools = vi.fn().mockRejectedValue(providerFailure(502));
    await expect(retryTransientProviderFailure({ invoke: afterTools, nothingRan: () => false, signal: new AbortController().signal, onRetry: vi.fn(), delaysMs: [1] }))
      .rejects.toThrow('HTTP 502');
    expect(afterTools).toHaveBeenCalledTimes(1);

    const quota = vi.fn().mockRejectedValue(providerFailure(429));
    await expect(retryTransientProviderFailure({ invoke: quota, nothingRan: () => true, signal: new AbortController().signal, onRetry: vi.fn(), delaysMs: [1] }))
      .rejects.toThrow('HTTP 429');
    expect(quota).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when the Run is cancelled', async () => {
    const controller = new AbortController();
    const invoke = vi.fn().mockRejectedValue(providerFailure(502));
    const pending = retryTransientProviderFailure({ invoke, nothingRan: () => true, signal: controller.signal, onRetry: () => controller.abort(), delaysMs: [60_000] });
    await expect(pending).rejects.toThrow('HTTP 502');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
