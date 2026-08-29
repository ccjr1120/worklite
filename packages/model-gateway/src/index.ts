import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, InvalidToolInputError, JSONParseError, jsonSchema, streamText, tool, type LanguageModel, type LanguageModelUsage, type ModelMessage } from 'ai';

export type ModelProviderConfig =
  | {
      id: string;
      kind: 'deepseek';
      apiKey: string;
      baseUrl?: string;
      headers?: Readonly<Record<string, string>>;
    }
  | {
      id: string;
      kind: 'openai' | 'openai-compatible';
      apiKey: string;
      baseUrl?: string;
      organization?: string;
      project?: string;
      headers?: Readonly<Record<string, string>>;
    };

export type GatewayMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type GatewayAgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }> }
  | { role: 'tool'; content: Array<{ type: 'tool-result'; toolCallId: string; toolName: string; output: GatewayToolResultOutput }> };

export type GatewayToolResultOutput = { type: 'text' | 'error-text'; value: string };

export type GenerateAgentStepRequest = {
  provider: ModelProviderConfig;
  model: string;
  systemPrompt: string;
  messages: readonly GatewayAgentMessage[];
  skillScripts: Array<{ skillId: string; skillName: string; path: string }>;
  builtinTools?: readonly GatewayToolDefinition[];
  mcpTools?: readonly GatewayToolDefinition[];
  maxToolRounds?: number;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  onTextDelta?: (delta: string) => void | Promise<void>;
};

export type GatewayToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AgentStepResult = {
  text: string;
  responseMessages: GatewayAgentMessage[];
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown; skillId?: string; scriptPath?: string; arguments?: string[] }>;
  finishReason: string | null;
  contextDropped: number;
};

export type StreamTextRequest = {
  provider: ModelProviderConfig;
  model: string;
  systemPrompt?: string;
  messages: readonly GatewayMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
};

export type ModelUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
};

export type ModelResult = {
  text: string;
  usage: ModelUsage;
  finishReason: string | null;
};

export type ModelStream = {
  textStream: AsyncIterable<string>;
  result: Promise<ModelResult>;
};

export interface ModelGateway {
  streamText(request: StreamTextRequest): ModelStream;
  generateAgentStep(request: GenerateAgentStepRequest): Promise<AgentStepResult>;
}

export class ModelGatewayError extends Error {
  readonly code: 'INVALID_PROVIDER' | 'INVALID_REQUEST' | 'INVALID_TOOL_REQUEST' | 'INCOMPLETE_TOOL_REQUEST';

  constructor(code: ModelGatewayError['code'], message: string) {
    super(message);
    this.name = 'ModelGatewayError';
    this.code = code;
  }
}

export class AiSdkModelGateway implements ModelGateway {
  streamText(request: StreamTextRequest): ModelStream {
    const model = resolveModel(request.provider, request.model);
    const messages = toModelMessages(request.messages);
    const result = streamText({
      model,
      system: request.systemPrompt,
      messages,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      abortSignal: request.abortSignal,
    });

    return {
      textStream: result.textStream,
      result: Promise.all([result.text, result.usage, result.finishReason]).then(([text, usage, finishReason]) => ({
        text,
        usage: normalizeUsage(usage),
        finishReason,
      })),
    };
  }

  async generateAgentStep(request: GenerateAgentStepRequest): Promise<AgentStepResult> {
    const model = resolveModel(request.provider, request.model);
    const skillScript = tool({
      description: 'Run one script from an assigned Skill package immediately on the WorkLite host. Select only an exact Skill id and script path from the assigned script list.',
      inputSchema: jsonSchema<{ skillId: string; scriptPath: string; arguments: string[] }>({
        type: 'object',
        additionalProperties: false,
        required: ['skillId', 'scriptPath', 'arguments'],
        properties: {
          skillId: { type: 'string', enum: [...new Set(request.skillScripts.map((script) => script.skillId))] },
          scriptPath: { type: 'string', enum: request.skillScripts.map((script) => script.path) },
          arguments: { type: 'array', items: { type: 'string' } },
        },
      }),
    });
    const tools: Record<string, unknown> = {
      ...(request.skillScripts.length > 0 ? { skill_script: skillScript } : {}),
    };
    for (const definition of [...(request.builtinTools ?? []), ...(request.mcpTools ?? [])]) {
      if (!definition.name || tools[definition.name]) continue;
      tools[definition.name] = tool({
        description: definition.description,
        inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema as never),
      });
    }
    const context = trimAgentMessages(request.systemPrompt, request.messages, request.maxContextTokens ?? 12_000);
    const result = await generateAgentWithRetry({
      model,
      instructions: request.systemPrompt,
      messages: context.messages as ModelMessage[],
      tools: Object.keys(tools).length > 0 ? tools as never : undefined,
      maxOutputTokens: request.maxOutputTokens,
      abortSignal: request.abortSignal,
    }, request.abortSignal, request.onTextDelta);

    const invalidToolRequest = classifyInvalidToolRequest(result.toolCalls);
    if (invalidToolRequest) throw invalidToolRequest;
    const toolCalls = result.toolCalls.flatMap((call) => call ? normalizeAgentToolCall(call as { toolCallId: string; toolName: string; input: unknown }, tools) : []);
    return {
      text: result.text,
      responseMessages: normalizeResponseMessages(result.responseMessages, new Set(toolCalls.map((call) => call.toolCallId))),
      toolCalls,
      finishReason: result.finishReason,
      contextDropped: context.dropped,
    };
  }
}

async function generateAgentWithRetry(
  request: Parameters<typeof streamText>[0],
  signal: AbortSignal | undefined,
  onTextDelta?: (delta: string) => void | Promise<void>,
  maxAttempts = 3,
): Promise<Awaited<ReturnType<typeof generateText>>> {
  const attempts = Math.max(1, Math.min(4, Math.floor(maxAttempts)));
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    let emitted = false;
    try {
      const result = streamText(request);
      for await (const delta of result.textStream) {
        emitted = true;
        await onTextDelta?.(delta);
      }
      const [text, toolCalls, responseMessages, finishReason] = await Promise.all([result.text, result.toolCalls, result.responseMessages, result.finishReason]);
      return { text, toolCalls, responseMessages, finishReason } as Awaited<ReturnType<typeof generateText>>;
    } catch (error) {
      if (attempt + 1 >= attempts || emitted || signal?.aborted || !isRetryableGatewayError(error)) throw error;
      await abortableDelay(Math.min(250 * 2 ** attempt, 2_000), signal);
    }
  }
}

export function createModelGateway(): ModelGateway {
  return new AiSdkModelGateway();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length <= maxLength ? value.trim() : null;
}

function requiredString(value: unknown, maxLength: number): string | null {
  const normalized = boundedString(value, maxLength);
  return normalized ? normalized : null;
}

function argumentArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return [...value] as string[];
}

function resolveModel(provider: ModelProviderConfig, modelId: string): LanguageModel {
  if (!modelId.trim()) {
    throw new ModelGatewayError('INVALID_REQUEST', 'A model id is required.');
  }

  if (!provider.apiKey.trim()) {
    throw new ModelGatewayError('INVALID_PROVIDER', `Provider ${provider.id} has no usable API key.`);
  }

  const headers = provider.headers == null ? undefined : { ...provider.headers };

  if (provider.kind === 'deepseek') {
    return createDeepSeek({
      apiKey: provider.apiKey,
      baseURL: provider.baseUrl,
      headers,
    })(modelId);
  }

  return createOpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseUrl,
    organization: provider.organization,
    project: provider.project,
    headers,
  }).chat(modelId);
}

function toModelMessages(messages: readonly GatewayMessage[]): ModelMessage[] {
  return messages.map(({ role, content }) => ({ role, content }));
}

function normalizeAgentToolCall(call: { toolCallId: string; toolName: string; input: unknown }, tools: Record<string, unknown>): AgentStepResult['toolCalls'] {
  if (!tools[call.toolName]) return [];
  if (call.toolName !== 'skill_script') return [{ toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }];
  const input = asRecord(call.input);
  const skillId = requiredString(input?.skillId, 200);
  const scriptPath = requiredString(input?.scriptPath, 240);
  const argumentsValue = argumentArray(input?.arguments);
  return skillId && scriptPath && argumentsValue ? [{ toolCallId: call.toolCallId, toolName: 'skill_script', input: call.input, skillId, scriptPath, arguments: argumentsValue }] : [];
}

function trimAgentMessages(systemPrompt: string, messages: readonly GatewayAgentMessage[], maxTokens: number): { messages: GatewayAgentMessage[]; dropped: number } {
  const result = [...messages];
  const estimate = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);
  const total = () => Math.ceil(systemPrompt.length / 4) + result.reduce((sum, message) => sum + estimate(message) + 4, 0);
  let dropped = 0;
  while (result.length > 3 && total() > maxTokens) {
    const candidate = result[1];
    if (!candidate || candidate.role === 'tool') {
      result.splice(1, 1);
    } else {
      result.splice(1, 1);
      if (result[1]?.role === 'tool') result.splice(1, 1);
    }
    dropped += 1;
  }
  while (result[0]?.role === 'tool') {
    result.shift();
    dropped += 1;
  }
  return { messages: result, dropped };
}

async function generateWithRetry(
  request: Parameters<typeof generateText>[0],
  signal: AbortSignal | undefined,
  maxAttempts = 3,
): Promise<Awaited<ReturnType<typeof generateText>>> {
  const attempts = Math.max(1, Math.min(4, Math.floor(maxAttempts)));
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await generateText(request);
    } catch (error) {
      if (attempt + 1 >= attempts || signal?.aborted || !isRetryableGatewayError(error)) throw error;
      await abortableDelay(Math.min(250 * 2 ** attempt, 2_000), signal);
    }
  }
}

function isRetryableGatewayError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof DOMException && error.name === 'TimeoutError') return true;
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const status = record.statusCode ?? record.status ?? (record.response && typeof record.response === 'object' ? (record.response as Record<string, unknown>).status : undefined);
  return typeof status === 'number' && [408, 409, 429, 500, 502, 503, 504].includes(status);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function classifyInvalidToolRequest(calls: readonly unknown[]): ModelGatewayError | null {
  for (const value of calls) {
    const call = asRecord(value);
    if (call?.invalid !== true) continue;
    const error = call.error;
    const cause = InvalidToolInputError.isInstance(error) ? error.cause : null;
    if (JSONParseError.isInstance(cause) && isUnexpectedJsonEnd(cause.cause)) {
      return new ModelGatewayError('INCOMPLETE_TOOL_REQUEST', 'The model returned an incomplete Skill request. Its JSON ended before the request was complete.');
    }
    return new ModelGatewayError('INVALID_TOOL_REQUEST', 'The model returned an invalid Skill request. Its arguments could not be parsed or did not match the required structure.');
  }
  return null;
}

function isUnexpectedJsonEnd(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /unterminated|string in json at position|unexpected end|end of json/i.test(error.message);
}

function normalizeResponseMessages(messages: readonly ModelMessage[], acceptedToolCallIds: ReadonlySet<string>): GatewayAgentMessage[] {
  const normalized: GatewayAgentMessage[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const parts: Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }> = [];
      if (typeof message.content === 'string') {
        parts.push({ type: 'text', text: message.content });
      } else {
        for (const part of message.content) {
          if (part.type === 'text') parts.push({ type: 'text', text: part.text });
          if (part.type === 'tool-call' && acceptedToolCallIds.has(part.toolCallId)) parts.push({ type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
        }
      }
      if (parts.length > 0) normalized.push({ role: 'assistant', content: parts });
      continue;
    }
    if (message.role === 'tool') {
      const parts: Array<{ type: 'tool-result'; toolCallId: string; toolName: string; output: GatewayToolResultOutput }> = [];
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue;
        if (!acceptedToolCallIds.has(part.toolCallId)) {
          throw new ModelGatewayError('INVALID_TOOL_REQUEST', 'The model returned an invalid Skill request. Its arguments could not be parsed or did not match the required structure.');
        }
        parts.push({ type: 'tool-result', toolCallId: part.toolCallId, toolName: part.toolName, output: normalizeToolResultOutput(part.output) });
      }
      if (parts.length > 0) normalized.push({ role: 'tool', content: parts });
    }
  }
  return normalized;
}

function normalizeToolResultOutput(output: unknown): GatewayToolResultOutput {
  if (!output || typeof output !== 'object' || !('type' in output)) return { type: 'text', value: JSON.stringify(output) };
  if (output.type === 'error-text' && 'value' in output && typeof output.value === 'string') return { type: 'error-text', value: output.value };
  if (output.type === 'text' && 'value' in output && typeof output.value === 'string') return { type: 'text', value: output.value };
  return { type: 'text', value: JSON.stringify(output) };
}

function normalizeUsage(usage: LanguageModelUsage): ModelUsage {
  return {
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    totalTokens: usage.totalTokens ?? null,
    reasoningTokens: usage.outputTokenDetails.reasoningTokens ?? null,
  };
}
