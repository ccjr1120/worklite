import { Injectable } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatewayBaseURL, type GatewayCorrelation, type GatewayToolDefinition, type WorkflowAgentToolCall, type WorkflowAgentToolResult } from '@worklite/model-gateway';
import { CommandsService, type CommandStdioProcess } from '../commands/commands.service';

export type CodexBackendActivity = {
  phase: string;
  commandExecutionId: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  itemType?: string;
};

type CodexInvocation = {
  commandArguments: readonly string[];
  publicModelId: string;
  systemPrompt: string;
  input: string;
  tools: readonly GatewayToolDefinition[];
  signal: AbortSignal;
  correlation?: GatewayCorrelation;
  executeTool(call: WorkflowAgentToolCall, signal: AbortSignal): Promise<WorkflowAgentToolResult>;
  onTextDelta?: (delta: string) => void | Promise<void>;
  onEvent?: (activity: CodexBackendActivity) => void | Promise<void>;
};

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code: number; message: string };
};

// Protocol and native-tool exclusion researched against openai/codex rust-v0.160.0.
// Native environments stay empty: project effects run through WorkLite's journal.
@Injectable()
export class CodexAppServerService {
  constructor(private readonly commands: CommandsService) {}

  async execute(request: CodexInvocation): Promise<string> {
    request.signal.throwIfAborted();
    const home = await mkdtemp(join(tmpdir(), 'worklite-codex-team-'));
    const controller = new AbortController();
    const session = new CodexAppServerSession({ ...request, signal: controller.signal }, (error) => controller.abort(error));
    let process: CommandStdioProcess | undefined;
    let completed = false;
    let closing = false;
    const cancel = () => {
      if (session.threadId && session.turnId) {
        void session.call('turn/interrupt', { threadId: session.threadId, turnId: session.turnId }).catch(() => undefined);
      }
      session.fail(request.signal.reason ?? new Error('The Codex task was cancelled.'));
      if (process) void this.commands.cancel(process.executionId).catch(() => undefined);
    };
    try {
      process = await this.commands.openStdioProcess(
        appServerArguments(request), home, { CODEX_HOME: home },
        (event) => {
          if (event.type === 'stdout') session.consume(event.data);
        },
      );
      session.attach(process);
      void process.completion.then(() => {
        if (!closing) session.fail(new Error('Codex App Server stopped before completing its task.'));
      }, (error) => session.fail(error));
      request.signal.addEventListener('abort', cancel, { once: true });
      if (request.signal.aborted) { cancel(); request.signal.throwIfAborted(); }
      await session.activity('codex.started');
      const initialized = await session.call('initialize', {
        clientInfo: { name: 'worklite_agent_team', title: 'WorkLite Agent Team', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
      requireSupportedVersion(initialized.userAgent);
      await session.notify('initialized', {});
      const started = await session.call('thread/start', {
        model: request.publicModelId,
        modelProvider: 'worklite',
        cwd: home,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        environments: [],
        selectedCapabilityRoots: [],
        developerInstructions: [
          request.systemPrompt,
          'Project operations are provided only by WorkLite dynamic tools. Use read, write, glob, grep, bash and process_reference only when listed. Native execution environments are disabled.',
          'The real projectDirectory and its captured instructions are in the task input. File paths are relative to that directory. Use the WorkLite write tool for edits.',
          'Return the required Team JSON result. When authorization or a user decision is missing, return status waiting_for_input with one pendingInput question.',
        ].join('\n\n'),
        dynamicTools: request.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      });
      session.threadId = started.thread.id;
      await session.activity('codex.thread_started');
      const turn = await session.call('turn/start', {
        threadId: session.threadId,
        input: [{ type: 'text', text: request.input, text_elements: [] }],
      });
      session.turnId = turn.turn.id;
      await session.activity('codex.turn_started');
      const output = await session.result();
      request.signal.throwIfAborted();
      closing = true;
      await process.close();
      const execution = await process.completion;
      if (execution.status !== 'succeeded') throw new Error('Codex App Server did not shut down successfully.');
      await session.activity('codex.completed');
      completed = true;
      return output;
    } finally {
      request.signal.removeEventListener('abort', cancel);
      controller.abort(new Error('The Codex App Server session is closed.'));
      if (process && !completed) {
        await this.commands.cancel(process.executionId);
        await process.completion;
      }
      let toolFailure: unknown;
      try { await session.settleTools(); }
      catch (error) { toolFailure = error; }
      session.fail(new Error('The Codex App Server session is closed.'));
      await rm(home, { recursive: true, force: true });
      if (toolFailure) throw toolFailure;
    }
  }
}

class CodexAppServerSession {
  threadId?: string;
  turnId?: string;
  private transport?: CommandStdioProcess;
  private sequence = 0;
  private buffer = '';
  private text = '';
  private questionOutput?: string;
  private failed?: unknown;
  private toolFailure?: unknown;
  private readonly pending = new Map<number | string, { resolve: (result: any) => void; reject: (error: unknown) => void }>();
  private toolQueue = Promise.resolve();
  private eventQueue = Promise.resolve();
  private readonly finished: Promise<string>;
  private finish!: (text: string) => void;
  private reject!: (error: unknown) => void;

  constructor(private readonly request: CodexInvocation, private readonly onFailure: (error: unknown) => void) {
    this.finished = new Promise((resolve, reject) => { this.finish = resolve; this.reject = reject; });
    void this.finished.catch(() => undefined);
  }

  attach(transport: CommandStdioProcess): void { this.transport = transport; }

  async call(method: string, params: unknown): Promise<any> {
    if (this.failed) throw this.failed;
    const id = ++this.sequence;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    void result.catch(() => undefined);
    try { await this.send({ id, method, params }); }
    catch (error) { this.fail(error); }
    return result;
  }

  notify(method: string, params: unknown): Promise<void> { return this.send({ method, params }); }

  consume(data: string): void {
    this.buffer += data;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try { this.receive(JSON.parse(line) as RpcMessage); }
      catch (error) { this.fail(error); }
    }
  }

  fail(error: unknown): void {
    if (this.failed) return;
    this.failed = error;
    this.onFailure(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.reject(error);
  }

  async result(): Promise<string> {
    const text = await this.finished;
    await this.settleTools();
    await this.eventQueue;
    if (this.failed) throw this.failed;
    if (!text.trim()) throw new Error('Codex App Server returned an empty Team task result.');
    return text.trim();
  }

  async settleTools(): Promise<void> {
    await this.toolQueue;
    if (this.toolFailure) throw this.toolFailure;
  }

  activity(phase: string, item?: Record<string, any>): Promise<void> {
    const activity: CodexBackendActivity = {
      phase,
      commandExecutionId: this.transport!.executionId,
      ...(this.threadId ? { threadId: this.threadId } : {}),
      ...(this.turnId ? { turnId: this.turnId } : {}),
      ...(typeof item?.id === 'string' ? { itemId: item.id } : {}),
      ...(typeof item?.type === 'string' ? { itemType: item.type } : {}),
    };
    return Promise.resolve(this.request.onEvent?.(activity));
  }

  private receive(message: RpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`Codex App Server rejected a protocol request (${message.error.code}).`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.toolQueue = this.toolQueue.then(() => {
        if (this.failed) return;
        return this.respond(message);
      }).catch((error) => { this.toolFailure = error; this.fail(error); });
      return;
    }
    const params = message.params ?? {};
    if (this.threadId && params.threadId && params.threadId !== this.threadId) return;
    if (message.method === 'turn/started') this.turnId = params.turn?.id;
    if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      this.eventQueue = this.eventQueue.then(() => this.request.onTextDelta?.(params.delta)).then(() => undefined).catch((error) => this.fail(error));
    }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      if (message.method === 'item/completed' && params.item?.type === 'agentMessage' && typeof params.item.text === 'string') this.text = params.item.text;
      const activityType = `codex.${message.method.replace('/', '_')}`;
      this.eventQueue = this.eventQueue.then(() => this.activity(activityType, params.item)).catch((error) => this.fail(error));
    }
    if (message.method === 'turn/completed') {
      if (this.questionOutput) this.finish(this.questionOutput);
      else if (params.turn?.status === 'completed') this.finish(this.text);
      else this.fail(new Error(params.turn?.status === 'interrupted' ? 'The Codex turn was interrupted.' : 'The Codex turn failed. Inspect its Command execution evidence.'));
    }
  }

  private async respond(message: RpcMessage): Promise<void> {
    this.request.signal.throwIfAborted();
    const params = message.params ?? {};
    if (message.method === 'item/tool/call') {
      if (this.questionOutput) {
        await this.send({ id: message.id, result: { contentItems: [{ type: 'inputText', text: 'The Team task is waiting for the user.' }], success: false } });
        return;
      }
      if (params.threadId !== this.threadId || (this.turnId && params.turnId !== this.turnId) || params.namespace || !this.request.tools.some((tool) => tool.name === params.tool)) {
        throw new Error('Codex requested a tool outside the captured Team invocation.');
      }
      const output = await this.request.executeTool({ toolCallId: params.callId, toolName: params.tool, input: params.arguments }, this.request.signal);
      await this.send({ id: message.id, result: { contentItems: [{ type: 'inputText', text: output.value }], success: output.type === 'text' } });
      return;
    }
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
      await this.send({ id: message.id, result: { decision: 'decline' } });
      return;
    }
    if (message.method === 'item/permissions/requestApproval') {
      await this.send({ id: message.id, result: { permissions: {}, scope: 'turn' } });
      return;
    }
    if (message.method === 'item/tool/requestUserInput') {
      const questions = Array.isArray(params.questions) ? params.questions.map((item: { question?: string }) => item.question).filter(Boolean) : [];
      if (questions.length === 0) throw new Error('Codex returned a user question without question text.');
      this.questionOutput = JSON.stringify({ status: 'waiting_for_input', pendingInput: { question: questions.join('\n') } });
      await this.send({ id: message.id, result: { answers: {} } });
      await this.call('turn/interrupt', { threadId: this.threadId, turnId: params.turnId });
      this.finish(this.questionOutput);
      return;
    }
    await this.send({ id: message.id, error: { code: -32601, message: 'This request is unavailable in WorkLite Team execution.' } });
    throw new Error('Codex requested an unsupported client capability.');
  }

  private send(message: unknown): Promise<void> {
    if (!this.transport) return Promise.reject(new Error('Codex App Server transport is unavailable.'));
    return this.transport.write(`${JSON.stringify(message)}\n`);
  }
}

function appServerArguments(request: CodexInvocation): string[] {
  const config: Record<string, unknown> = {
    model_provider: 'worklite',
    model: request.publicModelId,
    approval_policy: 'never',
    sandbox_mode: 'read-only',
    web_search: 'disabled',
    notify: [],
    'features.shell_tool': false,
    'features.stable_environment_tools': false,
    'features.hooks': false,
    'features.multi_agent': false,
    'features.multi_agent_v2': false,
    'features.apps': false,
    'features.code_mode': false,
    'features.image_generation': false,
    'features.skill_mcp_dependency_install': false,
    'model_providers.worklite.name': 'WorkLite Gateway',
    'model_providers.worklite.base_url': gatewayBaseURL(),
    'model_providers.worklite.wire_api': 'responses',
    'model_providers.worklite.requires_openai_auth': false,
    'model_providers.worklite.supports_websockets': false,
    'model_providers.worklite.http_headers': {
      'x-worklite-log-source': 'team',
      ...(request.correlation?.teamRunId ? { 'x-worklite-team-run-id': request.correlation.teamRunId } : {}),
      ...(request.correlation?.teamTaskAttemptId ? { 'x-worklite-team-task-attempt-id': request.correlation.teamTaskAttemptId } : {}),
    },
  };
  return [...request.commandArguments, ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${tomlValue(value)}`]), 'app-server', '--listen', 'stdio://'];
}

function tomlValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  return `{ ${Object.entries(value as Record<string, unknown>).map(([key, entry]) => `${JSON.stringify(key)} = ${tomlValue(entry)}`).join(', ')} }`;
}

function requireSupportedVersion(userAgent: unknown): void {
  const match = typeof userAgent === 'string' ? userAgent.match(/\b(\d+)\.(\d+)\.(\d+)\b/) : null;
  if (!match || (Number(match[1]) === 0 && Number(match[2]) < 160)) {
    throw new Error('Agent Team developer execution requires Codex 0.160.0 or later with App Server dynamic tools and empty environments.');
  }
}
