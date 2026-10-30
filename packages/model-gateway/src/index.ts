import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, generateText, InvalidToolInputError, isStepCount, JSONParseError, jsonSchema, NoOutputGeneratedError, Output, streamText, ToolLoopAgent, tool, wrapLanguageModel, type LanguageModel, type LanguageModelCallEndEvent, type LanguageModelUsage, type ModelMessage, type PrepareStepFunction, type ToolExecutionEndEvent, type ToolSet } from 'ai';
import { gatewayAttributionHeaders, type GatewayCorrelation } from './attribution.ts';

// The Anthropic protocol requires max_tokens and the AI SDK defaults it to 4096
// when unset, which silently truncates long Agent outputs (for example a
// Planner's JSON plan) mid-response. Give Agent loops a larger default budget;
// callers can still override through maxOutputTokens.
const DEFAULT_AGENT_MAX_OUTPUT_TOKENS = 32_768;

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

// Everything a user message can carry. Plain text is the ordinary case; the ordered part array
// exists for a turn that also carries images the user attached, which only the user role may hold
// because assistant text and tool results are always text on this boundary.
export type GatewayUserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mediaType: string };

export type GatewayAgentMessage =
  | { role: 'user'; content: string | GatewayUserContentPart[] }
  | { role: 'assistant'; content: Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }> }
  | { role: 'tool'; content: Array<{ type: 'tool-result'; toolCallId: string; toolName: string; output: GatewayToolResultOutput }> };

export type GatewayToolResultOutput = { type: 'text' | 'error-text'; value: string };

export { gatewayAttributionHeaders, type GatewayCorrelation } from './attribution.ts';

// A model configuration slot may declare one model or an ordered list of fallback candidates; a plain
// string is a one-element list. The Gateway tries each candidate in order and switches to the next only
// on a retryable failure (network/timeout/429/5xx), never on a request-shape error.
export type PublicModelList = string | readonly string[];

export function normalizePublicModelList(value: PublicModelList): string[] {
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map((entry) => entry.trim()).filter(Boolean))];
}

export type ModelCandidate = { provider: ModelProviderConfig; model: string };

export type GenerateAgentStepRequest = {
  candidates: readonly ModelCandidate[];
  systemPrompt: string;
  jsonOutput?: boolean;
  correlation?: GatewayCorrelation;
  messages: readonly GatewayAgentMessage[];
  // A script with a typed tool is offered as that tool instead of through the generic skill_script selector.
  skillScripts: Array<{ skillId: string; skillName: string; path: string; tool?: GatewayToolDefinition }>;
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
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown; skillId?: string; scriptPath?: string; arguments?: string[]; modelToolName?: string }>;
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
  candidates: readonly ModelCandidate[];
  systemPrompt: string;
  initialUserContent: string;
  jsonOutput?: boolean;
  correlation?: GatewayCorrelation;
  skillScripts: Array<{ skillId: string; skillName: string; path: string }>;
  builtinTools?: readonly GatewayToolDefinition[];
  mcpTools: readonly GatewayToolDefinition[];
  maxToolRounds: number;
  // Tool round at which the loop tells the model how many rounds remain so it converges early.
  budgetReminderAtRound?: number;
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
  candidates: readonly ModelCandidate[];
  systemPrompt?: string;
  messages: readonly GatewayMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  correlation?: GatewayCorrelation;
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
  readonly code: 'INVALID_PROVIDER' | 'INVALID_REQUEST' | 'INVALID_TOOL_REQUEST' | 'INCOMPLETE_TOOL_REQUEST' | 'PROVIDER_REQUEST_FAILED';
  // The upstream HTTP status, when known, carried past modelFailure()'s wrapping so the
  // candidate-fallback loop can classify retryability without re-inspecting the AI SDK error.
  statusCode?: number;

  constructor(code: ModelGatewayError['code'], message: string) {
    super(message);
    this.name = 'ModelGatewayError';
    this.code = code;
  }
}

export class AiSdkModelGateway implements ModelGateway {
  streamText(request: StreamTextRequest): ModelStream {
    // No fallback loop here by design, not by omission: ModelStream hands back a synchronous
    // textStream before any provider failure can occur, so switching candidates after a failed
    // attempt would mean buffering the whole stream before yielding the first chunk (the
    // withWorkflowAgentStreamTransport approach), defeating the point of streaming. streamText's
    // only caller today (Chat's /summarize) resolves exactly one model, so only the first
    // candidate is attempted; a future caller that needs fallback here should get a buffered
    // variant rather than bolting a loop onto this streaming path.
    const first = request.candidates[0]!;
    const model = resolveModel(first.provider, first.model, request.correlation);
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
    const genericScripts = request.skillScripts.filter((script) => !script.tool);
    const typedScripts = new Map(request.skillScripts.flatMap((script) => script.tool ? [[script.tool.name, script] as const] : []));
    // Trimming only depends on the conversation, not the candidate, so it runs once outside the
    // fallback loop; everything that depends on the candidate's own adapter/protocol (tool strict
    // mode, provider options, model resolution) is rebuilt per attempt inside withModelFallback.
    const context = trimAgentMessages(request.systemPrompt, request.messages, request.maxContextTokens);

    return withModelFallback(request.candidates, async (candidate) => {
      const model = resolveModel(candidate.provider, candidate.model, request.correlation);
      const useResponses = isResponsesProvider(candidate.provider);
      const skillScript = tool({
        description: 'Run one script from an assigned Skill package immediately on the WorkLite host. Select only an exact Skill id and script path from the assigned script list. arguments must be a command-line string array: use [] for a script with no input; for a JSON-input script use one serialized JSON string, never a nested object or array.',
        strict: useResponses ? false : undefined,
        inputSchema: jsonSchema<{ skillId: string; scriptPath: string; arguments: string[] }>({
          type: 'object',
          additionalProperties: false,
          required: ['skillId', 'scriptPath', 'arguments'],
          properties: {
            skillId: { type: 'string', enum: [...new Set(genericScripts.map((script) => script.skillId))] },
            scriptPath: { type: 'string', enum: genericScripts.map((script) => script.path) },
            arguments: { type: 'array', items: { type: 'string' } },
          },
        }),
      });
      const tools: Record<string, unknown> = {
        ...(genericScripts.length > 0 ? { skill_script: skillScript } : {}),
      };
      for (const definition of [...typedScripts.values()].map((script) => script.tool!)) {
        if (tools[definition.name]) continue;
        tools[definition.name] = tool({
          description: definition.description,
          strict: useResponses ? false : undefined,
          inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema as never),
        });
      }
      for (const definition of [...(request.builtinTools ?? []), ...(request.mcpTools ?? [])]) {
        if (!definition.name || tools[definition.name]) continue;
        tools[definition.name] = tool({
          description: definition.description,
          strict: useResponses ? false : undefined,
          inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema as never),
        });
      }
      const openaiProviderOptions = {
        ...(candidate.provider.adapter === 'openai' ? { parallelToolCalls: false as const } : {}),
        ...(useResponses ? { strictJsonSchema: false as const } : {}),
        ...(candidate.provider.adapter === 'codex' ? { store: false as const, include: ['reasoning.encrypted_content'] } : {}),
      };
      const modelRequest = {
        model,
        system: request.systemPrompt,
        output: request.jsonOutput ? Output.json({ name: 'response' }) : undefined,
        messages: context.messages as ModelMessage[],
        tools: Object.keys(tools).length > 0 ? tools as never : undefined,
        providerOptions: Object.keys(openaiProviderOptions).length > 0 ? { openai: openaiProviderOptions } : undefined,
        maxOutputTokens: request.maxOutputTokens ?? DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
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

      return toAgentStepResult(result, tools, typedScripts, context.dropped, request.jsonOutput === true);
    });
  }

  // Wraps the whole tool loop per candidate, exactly like generateAgentStep: a fallback-eligible
  // failure restarts the entire attempt against the next candidate from the initial user content.
  // A failure that happens after a tool already executed (toolCallsUsed > 0) still restarts; a
  // restarted attempt can re-request and re-run the same tool, so a caller whose tools are not
  // idempotent can observe a duplicated side effect on fallback. This mirrors the accepted
  // same-candidate retry behavior in withWorkflowAgentStreamTransport and is a known, not solved,
  // limitation of request-level model fallback for a multi-round tool loop.
  async runWorkflowAgent(request: RunWorkflowAgentRequest): Promise<WorkflowAgentLoopResult> {
    return withModelFallback(request.candidates, (candidate) => this.runWorkflowAgentAttempt(request, candidate));
  }

  private async runWorkflowAgentAttempt(request: RunWorkflowAgentRequest, candidate: ModelCandidate): Promise<WorkflowAgentLoopResult> {
    const model = withWorkflowAgentStreamTransport(
      resolveModel(candidate.provider, candidate.model, request.correlation),
      request.abortSignal,
    );
    const useResponses = isResponsesProvider(candidate.provider);
    const maxToolCalls = request.maxToolCalls ?? Infinity;
    const maxToolRounds = Math.max(0, Math.floor(request.maxToolRounds));
    let currentRound = 0;
    let contextDropped = 0;
    let toolCallsUsed = 0;
    let budgetMessageAdded = false;
    // The SDK applies prepared messages to one step only. The reminder is re-inserted at the
    // history position where it was first sent so later requests keep a stable cached prefix.
    const reminderRound = request.budgetReminderAtRound;
    let reminderIndex: number | undefined;
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
      description: 'Run one script from an assigned Skill package immediately on the WorkLite host. Select only an exact Skill id and script path from the assigned script list. arguments must be a command-line string array: use [] for a script with no input; for a JSON-input script use one serialized JSON string, never a nested object or array.',
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
      ...(candidate.provider.adapter === 'openai' ? { parallelToolCalls: false as const } : {}),
      ...(useResponses ? { strictJsonSchema: false as const } : {}),
      ...(candidate.provider.adapter === 'codex' ? { store: false as const, include: ['reasoning.encrypted_content'] } : {}),
    };
    const agentSettings = {
      model,
      instructions: request.systemPrompt,
      messages: [{ role: 'user', content: request.initialUserContent }] satisfies ModelMessage[],
      output: request.jsonOutput ? Output.json({ name: 'response' }) : undefined,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      providerOptions: Object.keys(openaiProviderOptions).length > 0 ? { openai: openaiProviderOptions } : undefined,
      maxOutputTokens: request.maxOutputTokens ?? DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
      abortSignal: request.abortSignal,
      maxRetries: 0,
      stopWhen: isStepCount(maxToolRounds + 1),
      prepareStep: ({ stepNumber, messages }: Parameters<PrepareStepFunction<ToolSet>>[0]) => {
        currentRound = stepNumber;
        const reminded = withBudgetReminder(messages as readonly GatewayAgentMessage[], stepNumber, maxToolRounds, reminderRound, reminderIndex);
        reminderIndex = reminded.reminderIndex;
        const context = trimAgentMessages(request.systemPrompt, reminded.messages, request.maxContextTokens);
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
          model: candidate.model,
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
  let index = 0;
  while (index < source.length) {
    const opening = source[index];
    if (opening !== '{' && opening !== '[') {
      index += 1;
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let closingIndex = -1;
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
          closingIndex = end;
          break;
        }
      }
    }

    if (closingIndex < 0) {
      index += 1;
      continue;
    }

    const candidate = parse(source.slice(index, closingIndex + 1));
    if (candidate !== null) return candidate;

    // Skip the complete candidate rather than retrying nested objects. A nested
    // object is not the requested top-level JSON response even when it parses.
    index = closingIndex + 1;
  }

  throw new Error('Agent JSON output requires valid JSON.');
}

function modelFailure(error: unknown, streamCause: unknown): Error {
  if ([error, streamCause].some((value) => value instanceof Error && /context_length_exceeded|Prompt exceeds max length|maximum context length/i.test(value.message))) {
    return new ModelGatewayError('INVALID_REQUEST', 'The model context limit was exceeded. Inspect focused diagnostic records or start a new conversation; complete evidence remains in the execution records.');
  }
  const cause = APICallError.isInstance(streamCause) ? streamCause : APICallError.isInstance(error) ? error : undefined;
  const status = cause?.statusCode;
  if (status) {
    const failure = new ModelGatewayError('PROVIDER_REQUEST_FAILED', `模型服务请求失败（HTTP ${status}），请稍后重试。`);
    failure.statusCode = status;
    return failure;
  }
  if (NoOutputGeneratedError.isInstance(error)) {
    return new ModelGatewayError('PROVIDER_REQUEST_FAILED', '模型服务未返回可用内容，请检查连接和模型能力后重试。');
  }
  return error instanceof Error ? error : new Error('The model request failed.');
}

const FALLBACK_ELIGIBLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);

// Decides whether a candidate switch is worth trying after a candidate's own internal
// same-model retry (generateAgentWithRetry, withWorkflowAgentStreamTransport) is exhausted.
// A status-bearing failure is judged on that status, exactly like isRetryableGatewayError;
// a provider that never returned output (NoOutputGeneratedError, wrapped with no status) is
// treated the same way, since it is already a transient failure class in this design. A
// request-shape error (context length, invalid/incomplete tool request) is never eligible:
// another model would fail the same way.
function isFallbackEligible(error: unknown): boolean {
  if (error instanceof ModelGatewayError) {
    if (error.code === 'INVALID_REQUEST' || error.code === 'INVALID_TOOL_REQUEST' || error.code === 'INCOMPLETE_TOOL_REQUEST') return false;
    if (typeof error.statusCode === 'number') return FALLBACK_ELIGIBLE_STATUS_CODES.has(error.statusCode);
    return error.code === 'PROVIDER_REQUEST_FAILED';
  }
  return isRetryableGatewayError(error);
}

// Tries each candidate in order, switching only on a fallback-eligible failure. The combined
// message names every attempted model and its own failure reason so a caller's error already
// states what was tried, without a separate inspection step.
async function withModelFallback<T>(
  candidates: readonly ModelCandidate[],
  attempt: (candidate: ModelCandidate) => Promise<T>,
): Promise<T> {
  const failures: Array<{ model: string; reason: string }> = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    try {
      return await attempt(candidate);
    } catch (error) {
      const label = `${candidate.provider.gatewayProviderName ?? candidate.provider.id}/${candidate.model}`;
      failures.push({ model: label, reason: error instanceof Error ? error.message : String(error) });
      if (!isFallbackEligible(error) || index === candidates.length - 1) {
        if (failures.length === 1) throw error;
        throw new ModelGatewayError('PROVIDER_REQUEST_FAILED', `所有候选模型均失败：${failures.map((failure) => `${failure.model}（${failure.reason}）`).join('；')}`);
      }
    }
  }
  throw new ModelGatewayError('PROVIDER_REQUEST_FAILED', 'No model candidate was attempted.');
}

function isResponsesProvider(provider: ModelProviderConfig): boolean {
  return provider.adapter === 'codex' || provider.operation === 'responses';
}

function toAgentStepResult(
  result: Awaited<ReturnType<typeof generateText>>,
  tools: Record<string, unknown>,
  typedScripts: ReadonlyMap<string, { skillId: string; path: string }>,
  contextDropped: number,
  jsonOutput: boolean,
): AgentStepResult {
  const invalidToolRequest = classifyInvalidToolRequest(result.toolCalls);
  if (invalidToolRequest) throw invalidToolRequest;
  const toolCalls = result.toolCalls.flatMap((call) => call ? normalizeAgentToolCall(call as { toolCallId: string; toolName: string; input: unknown }, tools, typedScripts) : []);
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
    ...gatewayAttributionHeaders(correlation),
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

export function gatewayBaseURL(): string {
  const apiURL = process.env.WORKLITE_API_URL?.trim();
  return apiURL ? `${apiURL.replace(/\/$/, '')}/portkey-gateway/v1` : 'http://127.0.0.1:23392/v1';
}

function toModelMessages(messages: readonly GatewayMessage[]): ModelMessage[] {
  return messages.map(({ role, content }) => ({ role, content }));
}

function normalizeAgentToolCall(call: { toolCallId: string; toolName: string; input: unknown }, tools: Record<string, unknown>, typedScripts: ReadonlyMap<string, { skillId: string; path: string }>): AgentStepResult['toolCalls'] {
  if (!tools[call.toolName]) return [];
  // A typed script tool runs as the same skill_script invocation, with its JSON object as the single argument.
  const typedScript = typedScripts.get(call.toolName);
  if (typedScript) {
    return [{ toolCallId: call.toolCallId, toolName: 'skill_script', modelToolName: call.toolName, input: call.input, skillId: typedScript.skillId, scriptPath: typedScript.path, arguments: [JSON.stringify(call.input ?? {})] }];
  }
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
// From reminderRound on, inserts one budget reminder at the history position where it was first
// sent. The caller keeps the returned reminderIndex and passes it back on the next step.
export function withBudgetReminder(
  messages: readonly GatewayAgentMessage[],
  stepNumber: number,
  maxToolRounds: number,
  reminderRound: number | undefined,
  reminderIndex: number | undefined,
): { messages: readonly GatewayAgentMessage[]; reminderIndex: number | undefined } {
  if (reminderRound === undefined || reminderRound <= 0 || reminderRound >= maxToolRounds || stepNumber < reminderRound) {
    return { messages, reminderIndex };
  }
  const index = Math.min(reminderIndex ?? messages.length, messages.length);
  return {
    messages: [
      ...messages.slice(0, index),
      {
        role: 'user',
        content: `Tool budget reminder: at most ${maxToolRounds - reminderRound} tool rounds remain. Stop broad exploration, gather only evidence a material decision still needs, issue independent calls together in one round, and then return the final response.`,
      },
      ...messages.slice(index),
    ],
    reminderIndex: index,
  };
}

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
