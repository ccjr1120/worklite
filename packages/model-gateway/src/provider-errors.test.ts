import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelGateway, ModelGatewayError } from './index';

// The body the Gateway logged for Chat's exhausted DeepSeek quota on 2026-10-31.
const QUOTA_BODY = JSON.stringify({
  error: {
    message: 'openai error: You have exceeded the weekly usage quota. It will reset at 2026-11-02 00:00:00 +0800 CST. We recommend upgrading your plan for more quota, or waiting for the reset. Request id: 02179342438148816a297e698c513f628e682a266b136091fd0ec',
    type: 'TooManyRequests',
    code: 'AccountQuotaExceeded',
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider request failures', () => {
  it('reports the provider status and reason after the SDK retries are exhausted', async () => {
    const fetchMock = vi.fn(async () => new Response(QUOTA_BODY, { status: 429, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const failure = await createModelGateway().generateAgentStep({
      candidates: [{ provider: { id: 'p', adapter: 'openai', operation: 'responses', apiKey: 'key' }, model: 'deepseek-v4.1-flash' }],
      systemPrompt: 'You are Chat.',
      messages: [{ role: 'user', content: '如何了' }],
      skillScripts: [],
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ModelGatewayError);
    expect((failure as ModelGatewayError).code).toBe('PROVIDER_REQUEST_FAILED');
    expect((failure as ModelGatewayError).statusCode).toBe(429);
    expect((failure as Error).message).toContain('HTTP 429');
    expect((failure as Error).message).toContain('weekly usage quota');
    expect((failure as Error).message).toContain('2026-11-02 00:00:00');
    expect((failure as Error).message).not.toContain('Request id');
  }, 30_000);
});
