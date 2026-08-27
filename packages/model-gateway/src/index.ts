import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, jsonSchema, streamText, tool, type LanguageModel, type LanguageModelUsage, type ModelMessage } from 'ai';

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
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
};

export type AgentStepResult = {
  text: string;
  responseMessages: GatewayAgentMessage[];
  toolCalls: Array<{ toolCallId: string; toolName: 'skill_script'; skillId: string; scriptPath: string; arguments: string[] }>;
  finishReason: string | null;
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
  readonly code: 'INVALID_PROVIDER' | 'INVALID_REQUEST';

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
          arguments: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 2_000 } },
        },
      }),
    });
    const tools = {
      ...(request.skillScripts.length > 0 ? { skill_script: skillScript } : {}),
    };
    const result = await generateText({
      model,
      instructions: request.systemPrompt,
      messages: request.messages as ModelMessage[],
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      maxOutputTokens: request.maxOutputTokens,
      abortSignal: request.abortSignal,
    });

    const toolCalls = result.toolCalls.flatMap((call) => call ? normalizeAgentToolCall(call as { toolCallId: string; toolName: string; input: unknown }) : []);
    return {
      text: result.text,
      responseMessages: normalizeResponseMessages(result.responseMessages, new Set(toolCalls.map((call) => call.toolCallId))),
      toolCalls,
      finishReason: result.finishReason,
    };
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

function argumentArray(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string' || item.length > maxLength)) return null;
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

function normalizeAgentToolCall(call: { toolCallId: string; toolName: string; input: unknown }): AgentStepResult['toolCalls'] {
  if (call.toolName !== 'skill_script') return [];
  const input = asRecord(call.input);
  const skillId = requiredString(input?.skillId, 200);
  const scriptPath = requiredString(input?.scriptPath, 240);
  const argumentsValue = argumentArray(input?.arguments, 100, 2_000);
  return skillId && scriptPath && argumentsValue ? [{ toolCallId: call.toolCallId, toolName: 'skill_script', skillId, scriptPath, arguments: argumentsValue }] : [];
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
        if (part.type === 'tool-result') parts.push({ type: 'tool-result', toolCallId: part.toolCallId, toolName: part.toolName, output: normalizeToolResultOutput(part.output) });
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
