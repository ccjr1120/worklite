import { normalizeTokenUsage, usageFromStreamEvents } from './token-usage';

describe('gateway token usage normalization', () => {
  it('separates Anthropic fresh input, cache reads, and cache creation', () => {
    expect(
      normalizeTokenUsage(
        {
          input_tokens: 12,
          output_tokens: 8,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
        },
        '/v1/messages'
      )
    ).toEqual({
      promptTokens: 12,
      completionTokens: 8,
      inputTokenSemantics: 'fresh',
      cacheReadTokens: 100,
      cacheCreationTokens: 20,
      totalTokens: 140,
    });
  });

  it('removes OpenAI cached input before reporting fresh input while keeping the full total', () => {
    expect(
      normalizeTokenUsage(
        {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: { cached_tokens: 70 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
        '/v1/chat/completions'
      )
    ).toEqual({
      promptTokens: 100,
      completionTokens: 5,
      inputTokenSemantics: 'total',
      cacheReadTokens: 70,
      cacheCreationTokens: 0,
      totalTokens: 105,
    });
  });

  it('merges Anthropic message_start and message_delta usage for streams', () => {
    const usage = usageFromStreamEvents([
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 12,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 20,
          },
        },
      },
      { type: 'content_block_delta', delta: { text: 'hello' } },
      { type: 'message_delta', usage: { output_tokens: 8 } },
    ]);

    expect(normalizeTokenUsage(usage, '/v1/messages')).toEqual({
      promptTokens: 12,
      completionTokens: 8,
      inputTokenSemantics: 'fresh',
      cacheReadTokens: 100,
      cacheCreationTokens: 20,
      totalTokens: 140,
    });
  });

  it('accepts corrected fresh Anthropic input and ignores zero cache stubs', () => {
    const usage = usageFromStreamEvents([
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 10,
          },
        },
      },
      {
        type: 'message_delta',
        usage: {
          input_tokens: 20,
          cache_read_input_tokens: 70,
          output_tokens: 8,
        },
      },
      {
        type: 'message_delta',
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 8,
        },
      },
    ]);

    expect(normalizeTokenUsage(usage, '/v1/messages')).toEqual({
      promptTokens: 20,
      completionTokens: 8,
      inputTokenSemantics: 'fresh',
      cacheReadTokens: 70,
      cacheCreationTokens: 10,
      totalTokens: 108,
    });
  });

  it('reads Codex Responses usage from the response.completed envelope', () => {
    const usage = usageFromStreamEvents([
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 500,
            output_tokens: 60,
            total_tokens: 560,
            input_tokens_details: { cached_tokens: 400 },
            output_tokens_details: { reasoning_tokens: 10 },
          },
        },
      },
    ]);

    expect(normalizeTokenUsage(usage, '/v1/responses')).toEqual({
      promptTokens: 500,
      completionTokens: 60,
      inputTokenSemantics: 'total',
      cacheReadTokens: 400,
      cacheCreationTokens: 0,
      totalTokens: 560,
    });
  });

  it('keeps absent usage unavailable instead of inventing zeros', () => {
    expect(normalizeTokenUsage(undefined, '/v1/messages')).toEqual({
      promptTokens: null,
      completionTokens: null,
      inputTokenSemantics: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      totalTokens: null,
    });
    expect(usageFromStreamEvents([])).toBeUndefined();
  });
});
