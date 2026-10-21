export type InputTokenSemantics = 'fresh' | 'total';

export type GatewayTokenUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  inputTokenSemantics: InputTokenSemantics | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  totalTokens: number | null;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function tokenValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function firstPositiveOrPresent(values: unknown[]): number {
  const tokens = values
    .map(tokenValue)
    .filter((value): value is number => value !== null);
  return tokens.find((value) => value > 0) ?? tokens[0] ?? 0;
}

function mergeRecords(previous: JsonRecord, next: JsonRecord): JsonRecord {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if ((value === null || value === undefined) && Object.hasOwn(merged, key)) {
      continue;
    }
    const previousRecord = asRecord(merged[key]);
    const nextRecord = asRecord(value);
    merged[key] =
      previousRecord && nextRecord
        ? { ...previousRecord, ...nextRecord }
        : value;
  }
  return merged;
}

function mergeAnthropicDelta(
  previous: JsonRecord,
  next: JsonRecord,
  inputFromDelta: boolean
): { usage: JsonRecord; inputFromDelta: boolean } {
  const merged = mergeRecords(previous, next);
  const previousInput = tokenValue(previous.input_tokens);
  const deltaInput = tokenValue(next.input_tokens);
  const useDeltaInput =
    deltaInput !== null &&
    deltaInput > 0 &&
    (previousInput === null ||
      previousInput === 0 ||
      deltaInput < previousInput ||
      (inputFromDelta && deltaInput <= previousInput));

  if (Object.hasOwn(next, 'input_tokens') && !useDeltaInput) {
    if (previousInput === null) delete merged.input_tokens;
    else merged.input_tokens = previousInput;
  }

  for (const key of [
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
  ]) {
    const previousValue = tokenValue(previous[key]);
    const nextValue = tokenValue(next[key]);
    if (useDeltaInput) {
      if (nextValue !== null) merged[key] = nextValue;
    } else if (previousValue !== null && previousValue > 0) {
      merged[key] = previousValue;
    } else if (nextValue !== null) {
      merged[key] = nextValue;
    }
  }

  return { usage: merged, inputFromDelta: inputFromDelta || useDeltaInput };
}

/**
 * Merge the usage fragments used by supported streaming protocols. Anthropic
 * sends input and cache counts in message_start, then output in message_delta;
 * OpenAI/Codex usually send one final usage object.
 */
export function usageFromStreamEvents(
  events: readonly unknown[]
): JsonRecord | undefined {
  let usage: JsonRecord | undefined;
  let inputFromDelta = false;
  for (const value of events) {
    const event = asRecord(value);
    if (!event) continue;
    const message = asRecord(event.message);
    const response = asRecord(event.response);
    const candidates = [
      asRecord(message?.usage),
      asRecord(event.usage),
      asRecord(response?.usage),
    ];
    for (const [index, candidate] of candidates.entries()) {
      if (!candidate) continue;
      if (event.type === 'message_delta' && index === 1) {
        const merged = mergeAnthropicDelta(
          usage ?? {},
          candidate,
          inputFromDelta
        );
        usage = merged.usage;
        inputFromDelta = merged.inputFromDelta;
      } else {
        usage = mergeRecords(usage ?? {}, candidate);
      }
    }
  }
  return usage;
}

/**
 * Normalize provider usage into the fields used by WorkLite and CC Switch.
 * OpenAI/Codex input counts include cached tokens; Anthropic input counts do
 * not. Keep the raw input plus its semantics so aggregation can show fresh
 * input while calculating a cache-inclusive total without double counting.
 */
export function normalizeTokenUsage(
  value: unknown,
  endpoint: string
): GatewayTokenUsage {
  const usage = asRecord(value);
  if (!usage) {
    return {
      promptTokens: null,
      completionTokens: null,
      inputTokenSemantics: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      totalTokens: null,
    };
  }

  const promptTokens =
    tokenValue(usage.prompt_tokens) ?? tokenValue(usage.input_tokens);
  const completionTokens =
    tokenValue(usage.completion_tokens) ?? tokenValue(usage.output_tokens);
  const inputDetails = asRecord(usage.input_tokens_details);
  const promptDetails = asRecord(usage.prompt_tokens_details);
  const cacheReadTokens = firstPositiveOrPresent([
    usage.cache_read_input_tokens,
    usage.cache_read_tokens,
    inputDetails?.cached_tokens,
    promptDetails?.cached_tokens,
    usage.prompt_cache_hit_tokens,
  ]);
  const cacheCreationTokens = firstPositiveOrPresent([
    usage.cache_creation_input_tokens,
    inputDetails?.cache_write_tokens,
    promptDetails?.cache_write_tokens,
  ]);
  const hasAnthropicCacheFields =
    Object.hasOwn(usage, 'cache_read_input_tokens') ||
    Object.hasOwn(usage, 'cache_creation_input_tokens');
  const isAnthropicMessagesEndpoint = /\/v1\/messages(?:\/|$)/i.test(endpoint);
  const inputTokenSemantics: InputTokenSemantics =
    hasAnthropicCacheFields || isAnthropicMessagesEndpoint ? 'fresh' : 'total';
  const freshInputTokens = freshPromptTokens(
    promptTokens,
    inputTokenSemantics,
    cacheReadTokens,
    cacheCreationTokens
  );
  const totalTokens =
    freshInputTokens !== null && completionTokens !== null
      ? freshInputTokens +
        cacheReadTokens +
        cacheCreationTokens +
        completionTokens
      : null;

  return {
    promptTokens,
    completionTokens,
    inputTokenSemantics,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
  };
}

export function freshPromptTokens(
  promptTokens: number | null,
  semantics: InputTokenSemantics | null,
  cacheReadTokens: number | null,
  cacheCreationTokens: number | null
): number | null {
  if (promptTokens === null) return null;
  if (semantics !== 'total') return promptTokens;
  return Math.max(
    0,
    promptTokens - (cacheReadTokens ?? 0) - (cacheCreationTokens ?? 0)
  );
}
