import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, generateText, InvalidToolInputError, isStepCount, JSONParseError, jsonSchema, NoOutputGeneratedError, Output, streamText, ToolLoopAgent, tool, wrapLanguageModel, type LanguageModel, type LanguageModelCallEndEvent, type LanguageModelUsage, type ModelMessage, type PrepareStepFunction, type ToolExecutionEndEvent, type ToolSet } from 'ai';

export type ModelProviderConfig =
  | {
      id: string;
      adapter: 'anthropic';
      apiKey: string;
      baseURL?: string;
      headers?: Readonly<Record<string, string>>;
      gatewayProviderName?: string;
      operation?: 'messages';
    }
  | {
      id: string;
      adapter: 'openai' | 'codex';
      apiKey: string;
      baseURL?: string;
      headers?: Readonly<Record<string, string>>;
      gatewayProviderName?: string;
      operation?: 'chat/completions' | 'responses';
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

export type GatewayCorrelation = {
  source: 'agent' | 'workflow' | 'team';
  workflowRunId?: string;
  nodeRunId?: string;
  teamRunId?: string;
  teamTaskAttemptId?: string;
  teamOperationKey?: string;
};

export type GenerateAgentStepRequest = {
  provider: ModelProviderConfig;
  model: string;
  systemPrompt: string;
  jsonOutput?: boolean;
  correlation?: GatewayCorrelation;
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

export type WorkflowAgentToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  skillId?: string;
  scriptPath?: string;
  arguments?: string[];
};

export type WorkflowAgentToolResult = {
  type: 'text' | 'error-text';
  value: string;
};

export type WorkflowAgentRound = {
  round: number;
  model: string;
  finishReason: string | null;
  toolCalls: number;
  contextDropped: number;
};

export type RunWorkflowAgentRequest = {
  provider: ModelProviderConfig;
  model: string;
  systemPrompt: string;
  initialUserContent: string;
  jsonOutput?: boolean;
  correlation?: GatewayCorrelation;
  skillScripts: Array<{ skillId: string; skillName: string; path: string }>;
  builtinTools?: readonly GatewayToolDefinition[];
  mcpTools: readonly GatewayToolDefinition[];
  maxToolRounds: number;
  maxToolCalls?: number;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  onTextDelta?: (delta: string) => void | Promise<void>;
  onModelRound?: (round: WorkflowAgentRound) => void | Promise<void>;
  executeTool: (call: WorkflowAgentToolCall) => Promise<WorkflowAgentToolResult>;
};

export type WorkflowAgentLoopResult = {
  text: string;
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
  runWorkflowAgent(request: RunWorkflowAgentRequest): Promise<WorkflowAgentLoopResult>;
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
    const model = resolveModel(request.provider, request.model, request.correlation);
    const useResponses = isResponsesProvider(request.provider);
    const skillScript = tool({
      description: 'Run one script from an assigned Skill package immediately on the WorkLite host. Select only an exact Skill id and script path from the assigned script list.',
      strict: useResponses ? false : undefined,
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
        strict: useResponses ? false : undefined,
        inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema as never),
      });
    }
    const context = trimAgentMessages(request.systemPrompt, request.messages, request.maxContextTokens);
    const openaiProviderOptions = {
      ...(request.provider.adapter === 'openai' ? { parallelToolCalls: false as const } : {}),
      ...(useResponses ? { strictJsonSchema: false as const } : {}),
    };
    const modelRequest = {
      model,
      system: request.systemPrompt,
      output: request.jsonOutput ? Output.json({ name: 'response' }) : undefined,
      messages: context.messages as ModelMessage[],
      tools: Object.keys(tools).length > 0 ? tools as never : undefined,
      providerOptions: Object.keys(openaiProviderOptions).length > 0 ? { openai: openaiProviderOptions } : undefined,
      maxOutputTokens: request.maxOutputTokens,
      abortSignal: request.abortSignal,
    };

    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateAgentWithRetry(modelRequest, request.abortSignal, request.onTextDelta);
    } catch (error) {
      if (!NoOutputGeneratedError.isInstance(error) || request.abortSignal?.aborted) throw modelFailure(error, error);
      try {
        result = await generateText(modelRequest);
      } catch (fallbackError) {
        throw modelFailure(fallbackError, error.cause ?? error);
      }
    }

    return toAgentStepResult(result, tools, context.dropped, request.jsonOutput === true);
  }

  async runWorkflowAgent(request: RunWorkflowAgentRequest): Promise<WorkflowAgentLoopResult> {
    const model = withWorkflowAgentStreamTransport(
      resolveModel(request.provider, request.model, request.correlation),
      request.abortSignal,
    );
    const useResponses = isResponsesProvider(request.provider);
    const maxToolCalls = request.maxToolCalls ?? Infinity;
    const maxToolRounds = Math.max(0, Math.floor(request.maxToolRounds));
    let currentRound = 0;
    let contextDropped = 0;
    let toolCallsUsed = 0;
    let budgetMessageAdded = false;
    let toolExecutionError: unknown;

    let lastToolTask = Promise.resolve();
    const runToolExclusively = <T>(operation: () => Promise<T>): Promise<T> => {
      const task = lastToolTask.then(operation, operation);
      lastToolTask = task.then(() => undefined, () => undefined);
      return task;
    };
    const recordToolExecutionError = (error: unknown): unknown => {
      toolExecutionError ??= error;
      return error;
    };
    const executeManagedTool = async (
      toolCallId: string,
      call: Omit<WorkflowAgentToolCall, 'toolCallId'>,
    ): Promise<WorkflowAgentToolResult> => runToolExclusively(async () => {
      if (toolExecutionError) {
        return { type: 'error-text', value: 'A previous tool call failed; no new host actions were started.' };
      }
      if (toolCallsUsed >= maxToolCalls) {
        return { type: 'error-text', value: 'The tool-call budget is exhausted; finish with existing evidence.' };
      }
      toolCallsUsed += 1;
      try {
        return await request.executeTool({ ...call, toolCallId });
      } catch (error) {
        throw recordToolExecutionError(error);
      }
    });

    const skillScript = tool({
      description: 'Run one script from an assigned Skill package immediately on the WorkLite host. Select only an exact Skill id and script path from the assigned script list.',
      strict: useResponses ? false : undefined,
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
      execute: (input, { toolCallId }) => {
        let normalized: WorkflowAgentToolCall;
        try {
          normalized = normalizeWorkflowSkillCall(toolCallId, input);
        } catch (error) {
          throw recordToolExecutionError(error);
        }
        return executeManagedTool(toolCallId, normalized);
      },
    });
    const tools: Record<string, unknown> = {
      ...(request.skillScripts.length > 0 ? { skill_script: skillScript } : {}),
    };
    for (const definition of request.builtinTools ?? []) {
      if (!definition.name || tools[definition.name]) continue;
      tools[definition.name] = tool({
        description: definition.description,
        strict: useResponses ? false : undefined,
        inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema as never),
        execute: (input, { toolCallId }) => executeManagedTool(toolCallId, { toolName: definition.name, input }),
      });
    }
    for (const definition of request.mcpTools) {
      if (!definition.name || tools[definition.name]) continue;
      tools[definition.name] = tool({
        description: definition.description,
        strict: useResponses ? false : undefined,
        inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema as never),
        execute: (input, { toolCallId }) => executeManagedTool(toolCallId, { toolName: definition.name, input }),
      });
    }

    const openaiProviderOptions = {
      ...(request.provider.adapter === 'openai' ? { parallelToolCalls: false as const } : {}),
      ...(useResponses ? { strictJsonSchema: false as const } : {}),
    };
    const agentSettings = {
      model,
      instructions: request.systemPrompt,
      messages: [{ role: 'user', content: request.initialUserContent }] satisfies ModelMessage[],
      output: request.jsonOutput ? Output.json({ name: 'response' }) : undefined,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      providerOptions: Object.keys(openaiProviderOptions).length > 0 ? { openai: openaiProviderOptions } : undefined,
      maxOutputTokens: request.maxOutputTokens,
      abortSignal: request.abortSignal,
      maxRetries: 0,
      stopWhen: isStepCount(maxToolRounds + 1),
      prepareStep: ({ stepNumber, messages }: Parameters<PrepareStepFunction<ToolSet>>[0]) => {
        currentRound = stepNumber;
        const context = trimAgentMessages(request.systemPrompt, messages as readonly GatewayAgentMessage[], request.maxContextTokens);
        contextDropped = context.dropped;
        const toolsClosed = stepNumber >= maxToolRounds || toolCallsUsed >= maxToolCalls;
        let nextMessages = context.messages;
        if (toolsClosed && !budgetMessageAdded) {
          budgetMessageAdded = true;
          nextMessages = [...nextMessages, {
            role: 'user',
            content: 'Tool budget is exhausted. Return the final response now using the evidence already gathered; state any evidence gaps. Do not call tools.',
          }];
        }
        return {
          messages: nextMessages,
          ...(toolsClosed ? { activeTools: [] } : {}),
        };
      },
      onToolExecutionEnd: async (event: ToolExecutionEndEvent<ToolSet>) => {
        if (event.toolOutput.type === 'tool-error') recordToolExecutionError(event.toolOutput.error);
      },
      onLanguageModelCallEnd: async (event: LanguageModelCallEndEvent<ToolSet>) => {
        await request.onModelRound?.({
          round: currentRound,
          model: request.model,
          finishReason: event.finishReason ?? null,
          toolCalls: event.content.filter((part) => part.type === 'tool-call').length,
          contextDropped,
        });
      },
    };
    const agent = new ToolLoopAgent(agentSettings as never) as ToolLoopAgent<never, ToolSet>;
    const result = await agent.stream({
      abortSignal: request.abortSignal,
      messages: [{ role: 'user', content: request.initialUserContent }],
    });
    let streamError: unknown;
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        await request.onTextDelta?.(part.text);
      } else if (part.type === 'error') {
        streamError ??= part.error;
      }
    }
    if (streamError) throw streamError;
    if (toolExecutionError) throw toolExecutionError;
    const [text, finalStep] = await Promise.all([result.text, result.finalStep]);
    const toolCalls = finalStep?.toolCalls ?? [];
    const invalidToolRequest = classifyInvalidToolRequest(toolCalls);
    if (invalidToolRequest) throw invalidToolRequest;
    if (!text.trim() && toolCalls.length > 0) {
      throw new Error('The Workflow Agent node requested a tool after its tool budget was exhausted.');
    }
    return { text: request.jsonOutput ? extractJsonText(text.trim()) : text };
  }
}

function normalizeWorkflowSkillCall(
  toolCallId: string,
  input: { skillId: string; scriptPath: string; arguments: string[] },
): WorkflowAgentToolCall {
  const skillId = requiredString(input?.skillId, 200);
  const scriptPath = requiredString(input?.scriptPath, 240);
  const argumentsValue = argumentArray(input?.arguments);
  if (!skillId || !scriptPath || !argumentsValue) {
    throw new ModelGatewayError('INVALID_TOOL_REQUEST', 'The model returned an invalid Skill request. Skill arguments must be scalar command-line values.');
  }
  return { toolCallId, toolName: 'skill_script', input, skillId, scriptPath, arguments: argumentsValue };
}

function withWorkflowAgentStreamTransport(model: LanguageModel, signal?: AbortSignal): LanguageModel {
  return wrapLanguageModel({
    model: model as never,
    middleware: {
      specificationVersion: 'v4',
      wrapStream: async ({ doStream, doGenerate }) => {
        let firstAttempt: Awaited<ReturnType<typeof doStream>> | undefined;
        let attempt = 0;
        const maxAttempts = 3;
        for (; attempt < maxAttempts; attempt += 1) {
          signal?.throwIfAborted();
          try {
            firstAttempt = await doStream();
            break;
          } catch (error) {
            if (attempt + 1 >= maxAttempts || signal?.aborted || !isRetryableGatewayError(error)) throw modelFailure(error, error);
            await abortableDelay(Math.min(250 * 2 ** attempt, 2_000), signal);
          }
        }
        const initial = firstAttempt;
        if (!initial) throw new Error('The provider returned no usable model output.');
        const stream = new ReadableStream<unknown>({
          start(controller) {
            void (async () => {
              let emitted = false;
              let preamble: unknown[] = [];
              let failure: unknown;
              for (let retryAttempt = attempt; retryAttempt < maxAttempts; retryAttempt += 1) {
                const reader = (retryAttempt === attempt ? initial : await doStream()).stream.getReader();
                preamble = emitted ? [] : [];
                try {
                  for (;;) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    const part = chunk.value as Record<string, unknown> | undefined;
                    const type = part?.type;
                    if (!part) {
                      if (emitted) controller.enqueue(part);
                      else preamble.push(part);
                      continue;
                    }
                    if (type === 'error') {
                      failure = part.error;
                      break;
                    }
                    if (type === 'text-delta' || type === 'tool-input-start' || type === 'tool-input-delta' || type === 'tool-call') {
                      emitted = true;
                      for (const queuedPart of preamble) controller.enqueue(queuedPart);
                      preamble = [];
                      controller.enqueue(part);
                      continue;
                    }
                    if (!emitted) preamble.push(part);
                    else controller.enqueue(part);
                  }
                  if (emitted) return;
                  failure ??= new NoOutputGeneratedError({ message: 'The provider returned no usable model output.' });
                  if (retryAttempt + 1 < maxAttempts && signal?.aborted !== true && isRetryableGatewayError(failure)) {
                    await abortableDelay(Math.min(250 * 2 ** retryAttempt, 2_000), signal);
                    continue;
                  }
                  if (signal?.aborted || !NoOutputGeneratedError.isInstance(failure)) throw failure;
                  const generated = await doGenerate();
                  for (const part of generatedResultToStreamParts(generated)) controller.enqueue(part);
                  return;
                } catch (error) {
                  failure = error;
                  if (retryAttempt + 1 < maxAttempts && !signal?.aborted && isRetryableGatewayError(error)) {
                    await abortableDelay(Math.min(250 * 2 ** retryAttempt, 2_000), signal);
                    continue;
                  }
                  if (!signal?.aborted && NoOutputGeneratedError.isInstance(error)) {
                    try {
                      const generated = await doGenerate();
                      for (const part of generatedResultToStreamParts(generated)) controller.enqueue(part);
                      return;
                    } catch (fallbackError) {
                      throw modelFailure(fallbackError, failure);
                    }
                  }
                  throw modelFailure(error, failure);
                }
              }
              throw modelFailure(failure, failure);
            })().then(() => {
              controller.close();
            }).catch((error) => controller.error(error));
          },
        });
        return {
          stream: stream as never,
          ...(initial.request ? { request: initial.request } : {}),
          ...(initial.response ? { response: initial.response } : {}),
        };
      },
    },
  }) as LanguageModel;
}

function generatedResultToStreamParts(generated: {
  content: Iterable<unknown>;
  finishReason: { unified: string; raw: string | undefined };
  usage: unknown;
  providerMetadata?: unknown;
  response?: object;
}): Array<unknown> {
  const parts: Array<unknown> = [{ type: 'stream-start', warnings: [] }];
  if (generated.response) {
    parts.push({ type: 'response-metadata', ...generated.response });
  }
  for (const value of generated.content) {
    const content = asRecord(value);
    if (!content) continue;
    if (content.type === 'text') {
      const id = 'fallback-text';
      parts.push({ type: 'text-start', id });
      parts.push({ type: 'text-delta', id, delta: content.text });
      parts.push({ type: 'text-end', id });
      continue;
    }
    if (content.type === 'reasoning') {
      const id = typeof content.id === 'string' ? content.id : 'fallback-reasoning';
      parts.push({ type: 'reasoning-start', id });
      if (typeof content.text === 'string') parts.push({ type: 'reasoning-delta', id, delta: content.text });
      parts.push({ type: 'reasoning-end', id });
      continue;
    }
    parts.push(content);
  }
  parts.push({
    type: 'finish',
    usage: generated.usage,
    finishReason: generated.finishReason,
    ...(generated.providerMetadata ? { providerMetadata: generated.providerMetadata } : {}),
  });
  return parts;
}

function extractJsonText(text: string): string {
  const parse = (value: string) => {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return null;
    }
  };

  const exact = parse(text.trim());
  if (exact !== null) return exact;

  const source = text.trim();
  for (const [index, character] of source.split('').entries()) {
    if (character !== '{' && character !== '[') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = index; end < source.length; end += 1) {
      const current = source[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === '"') inString = false;
        continue;
      }
      if (current === '"') inString = true;
      else if (current === '{' || current === '[') depth += 1;
      else if (current === '}' || current === ']') {
        depth -= 1;
        if (depth === 0) {
          const candidate = parse(source.slice(index, end + 1));
          if (candidate !== null) return candidate;
          break;
        }
      }
    }
  }

  throw new Error('Agent JSON output requires valid JSON.');
}

function modelFailure(error: unknown, streamCause: unknown): Error {
  const cause = APICallError.isInstance(streamCause) ? streamCause : APICallError.isInstance(error) ? error : undefined;
  const status = cause?.statusCode;
  if (status) return new Error(`The model provider request failed with HTTP status ${status}.`);
  if (NoOutputGeneratedError.isInstance(error)) {
    return new Error('The provider returned no usable model output. Check the provider connection and model capabilities.');
  }
  return error instanceof Error ? error : new Error('The model request failed.');
}

function isResponsesProvider(provider: ModelProviderConfig): boolean {
  return provider.adapter === 'codex' || provider.operation === 'responses';
}

function toAgentStepResult(
  result: Awaited<ReturnType<typeof generateText>>,
  tools: Record<string, unknown>,
  contextDropped: number,
  jsonOutput: boolean,
): AgentStepResult {
  const invalidToolRequest = classifyInvalidToolRequest(result.toolCalls);
  if (invalidToolRequest) throw invalidToolRequest;
  const toolCalls = result.toolCalls.flatMap((call) => call ? normalizeAgentToolCall(call as { toolCallId: string; toolName: string; input: unknown }, tools) : []);
  return {
    text: jsonOutput && toolCalls.length === 0 ? extractJsonText(result.text) : result.text,
    responseMessages: normalizeResponseMessages(result.responseMessages, new Set(toolCalls.map((call) => call.toolCallId))),
    toolCalls,
    finishReason: result.finishReason,
    contextDropped,
  };
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
    let streamError: unknown;
    try {
      const result = streamText({
        ...request,
        onError: ({ error }) => {
          streamError ??= error;
          request.onError?.({ error });
        },
      });
      for await (const delta of result.textStream) {
        emitted = true;
        await onTextDelta?.(delta);
      }
      const [text, toolCalls, responseMessages, finishReason] = await Promise.all([result.text, result.toolCalls, result.responseMessages, result.finishReason]);
      if (!emitted && streamError !== undefined) throw streamError;
      return { text, toolCalls, responseMessages, finishReason } as Awaited<ReturnType<typeof generateText>>;
    } catch (error) {
      const failure = streamError !== undefined && NoOutputGeneratedError.isInstance(error) ? streamError : error;
      if (attempt + 1 >= attempts || emitted || signal?.aborted || !isRetryableGatewayError(failure)) throw failure;
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
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean')) return null;
  return value.map(String);
}

function correlationHeaders(correlation: GatewayCorrelation | undefined): Record<string, string> {
  if (!correlation) return {};
  return {
    'x-worklite-log-source': correlation.source,
    ...(correlation.workflowRunId ? { 'x-worklite-workflow-run-id': correlation.workflowRunId } : {}),
    ...(correlation.nodeRunId ? { 'x-worklite-node-run-id': correlation.nodeRunId } : {}),
    ...(correlation.teamRunId ? { 'x-worklite-team-run-id': correlation.teamRunId } : {}),
    ...(correlation.teamTaskAttemptId ? { 'x-worklite-team-task-attempt-id': correlation.teamTaskAttemptId } : {}),
    ...(correlation.teamOperationKey ? { 'x-worklite-team-operation-key': correlation.teamOperationKey } : {}),
  };
}

function resolveModel(provider: ModelProviderConfig, modelId: string, correlation?: GatewayCorrelation): LanguageModel {
  if (!modelId.trim()) {
    throw new ModelGatewayError('INVALID_REQUEST', 'A model id is required.');
  }

  if (!provider.apiKey.trim() && provider.adapter !== 'codex') {
    throw new ModelGatewayError('INVALID_PROVIDER', `Provider ${provider.id} has no usable API key.`);
  }

  const forwardHeaders = Object.keys(provider.headers ?? {}).filter((name) => !name.toLowerCase().startsWith('x-worklite-'));
  const portkeyConfig = JSON.stringify({
    provider: provider.adapter,
    api_key: provider.apiKey,
    ...(provider.baseURL ? { custom_host: provider.baseURL } : {}),
    ...(forwardHeaders.length > 0 ? { forward_headers: forwardHeaders } : {}),
  });
  const headers = {
    ...(provider.headers ?? {}),
    ...(provider.gatewayProviderName ? { 'x-worklite-stat-provider': provider.gatewayProviderName } : {}),
    ...correlationHeaders(correlation),
    'x-portkey-config': portkeyConfig,
  };
  const baseURL = gatewayBaseURL();
  const gatewayModel = provider.gatewayProviderName ? `${provider.gatewayProviderName}/${modelId}` : modelId;

  if (provider.adapter === 'anthropic') {
    return createAnthropic({
      apiKey: 'worklite-gateway',
      baseURL,
      headers,
    })(gatewayModel) as unknown as LanguageModel;
  }

  const openai = createOpenAI({
    apiKey: 'worklite-gateway',
    baseURL,
    headers,
  });
  return provider.operation === 'responses' || provider.adapter === 'codex' ? openai.responses(gatewayModel) as unknown as LanguageModel : openai.chat(gatewayModel);
}

function gatewayBaseURL(): string {
  const apiURL = process.env.WORKLITE_API_URL?.trim();
  return apiURL ? `${apiURL.replace(/\/$/, '')}/portkey-gateway/v1` : 'http://127.0.0.1:3392/v1';
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
  if (!skillId || !scriptPath || !argumentsValue) {
    throw new ModelGatewayError('INVALID_TOOL_REQUEST', 'The model returned an invalid Skill request. Skill arguments must be scalar command-line values.');
  }
  return [{ toolCallId: call.toolCallId, toolName: 'skill_script', input: call.input, skillId, scriptPath, arguments: argumentsValue }];
}

// Trimming for size is opt-in. A fixed budget cannot know the model's real context window, and the
// loop below stops at three messages whether or not it has freed enough, so a budget set too low does
// not degrade gracefully: it silently discards every earlier tool result and the agent then reports
// work it no longer remembers doing. Callers that need a bound pass one; otherwise only the leading
// orphan tool messages are removed, which is a structural requirement rather than a size decision.
function trimAgentMessages(systemPrompt: string, messages: readonly GatewayAgentMessage[], maxTokens?: number): { messages: GatewayAgentMessage[]; dropped: number } {
  const result = [...messages];
  const estimate = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);
  const total = () => Math.ceil(systemPrompt.length / 4) + result.reduce((sum, message) => sum + estimate(message) + 4, 0);
  let dropped = 0;
  while (maxTokens !== undefined && result.length > 3 && total() > maxTokens) {
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
