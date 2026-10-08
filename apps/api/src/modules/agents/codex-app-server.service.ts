import { BadRequestException, Injectable } from '@nestjs/common';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gatewayBaseURL, type GatewayCorrelation, type GatewayToolDefinition, type WorkflowAgentToolCall, type WorkflowAgentToolResult } from '@worklite/model-gateway';
import { parse } from 'smol-toml';
import type { StoredCodexLaunch } from '@worklite/db';
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
  owner?: 'chat' | 'team';
  commandArguments: readonly string[];
  launch: StoredCodexLaunch;
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

export class CodexAppServerError extends Error {}

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code: number; message: string };
};

// Protocol and native-tool exclusion verified against openai/codex rust-v0.157.1.
// Native environments stay empty: project effects run through WorkLite's journal.
@Injectable()
export class CodexAppServerService {
  constructor(private readonly commands: CommandsService) {}

  async captureLaunch(commandArguments: readonly string[], mode?: 'cx' | 'cxo', model?: string): Promise<{ commandArguments: string[]; launch: StoredCodexLaunch }> {
    const alias = commandArguments[0] === 'cx' || commandArguments[0] === 'cxo' ? commandArguments[0] : undefined;
    const selected = mode ?? alias ?? 'cx';
    const home = join(homedir(), selected === 'cxo' ? '.codex' : '.codex-cli');
    let config: Record<string, any>;
    try { config = parse(await readFile(join(home, 'config.toml'), 'utf8')); }
    catch { throw new BadRequestException(`无法读取 ${selected} 的 Codex 配置：${home}/config.toml。`); }
    const selectedModel = model?.trim() || config.model;
    const modelProvider = config.model_provider ?? 'openai';
    if (typeof selectedModel !== 'string' || !selectedModel.trim() || typeof modelProvider !== 'string') throw new BadRequestException(`请先在 ${selected} 配置中设置模型和 Provider。`);
    if (selected === 'cxo' && selectedModel.includes('/')) throw new BadRequestException('cxo 使用原生 Codex 模型 id，不使用 Gateway 的 Provider 前缀。');
    const provider = config.model_providers?.[modelProvider];
    if (selected === 'cx' && provider?.wire_api !== 'responses') throw new BadRequestException('cx 的 Codex Provider 必须使用 Responses 协议。');
    if (selected === 'cx') {
      const current = new URL(gatewayBaseURL());
      const configured = new URL(provider.base_url);
      const currentPort = Number(current.port);
      const ports = currentPort >= 23390 && currentPort <= 23392 ? [23390, 23391, 23392] : currentPort >= 3390 && currentPort <= 3392 ? [3390, 3391, 3392] : [currentPort];
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(configured.hostname) || !ports.includes(Number(configured.port))) throw new BadRequestException('cx 的 Gateway 配置不属于当前 WorkLite 运行环境。');
    }
    const settings: Record<string, unknown> = { model: selectedModel, model_provider: modelProvider };
    for (const key of ['model_reasoning_effort', 'service_tier', 'model_catalog_json', 'disable_response_storage']) {
      if (typeof config[key] === 'string' || typeof config[key] === 'boolean') settings[key] = config[key];
    }
    if (typeof config.model_catalog_json === 'string') settings.model_catalog_json = resolve(home, config.model_catalog_json);
    if (provider) {
      const captured: Record<string, unknown> = {};
      for (const key of ['name', 'base_url', 'wire_api', 'requires_openai_auth', 'env_key', 'supports_websockets']) {
        if (typeof provider[key] === 'string' || typeof provider[key] === 'boolean') captured[key] = provider[key];
      }
      settings.model_providers = { [modelProvider]: captured };
    }
    const args = [...commandArguments];
    if (alias) args[0] = 'codex';
    if (!args.includes('--dangerously-bypass-approvals-and-sandbox')) args.push('--dangerously-bypass-approvals-and-sandbox');
    return { commandArguments: args, launch: { mode: selected, home, model: selectedModel, modelProvider, settings } };
  }

  async execute(request: CodexInvocation): Promise<string> {
    request.signal.throwIfAborted();
    const home = await mkdtemp(join(tmpdir(), `worklite-codex-${request.owner ?? 'team'}-`));
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
      const nativeConfig = parse(await readFile(join(request.launch.home, 'config.toml'), 'utf8'));
      const disabledMcp = Object.fromEntries(Object.keys(nativeConfig.mcp_servers ?? {}).map((name) => [name, { enabled: false }]));
      process = await this.commands.openStdioProcess(
        appServerArguments(request, disabledMcp), home, { CODEX_HOME: request.launch.home },
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
        clientInfo: { name: `worklite_${request.owner ?? 'team'}`, title: 'WorkLite', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
      requireSupportedVersion(initialized.userAgent);
      await session.notify('initialized', {});
      const started = await session.call('thread/start', {
        model: request.publicModelId,
        modelProvider: request.launch.modelProvider,
        cwd: home,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        ephemeral: true,
        environments: [],
        selectedCapabilityRoots: [],
        developerInstructions: [
          request.systemPrompt,
          'Project operations are provided only by WorkLite dynamic tools. Use read, write, glob, grep, bash and process_reference only when listed. The captured WorkLite tools permit project edits and command execution without WorkLite proposal confirmation or individual command grants. Native execution environments are disabled.',
          'The real projectDirectory and its captured instructions are in the task input. File paths are relative to that directory. Use the WorkLite write tool for edits.',
          request.owner === 'chat'
            ? 'Return JSON with status succeeded and summary, or status waiting_for_input with pendingInput.question for missing information. Execute the captured user task directly without WorkLite proposal confirmation or individual command grants.'
            : 'Return the required Team JSON result. When authorization or a user decision is missing, return status waiting_for_input with one pendingInput question.',
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
  private readonly pending = new Map<number | string, { method: string; resolve: (result: any) => void; reject: (error: unknown) => void }>();
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
    const result = new Promise((resolve, reject) => this.pending.set(id, { method, resolve, reject }));
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
    if (!text.trim()) throw new Error('Codex App Server returned an empty task result.');
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
      if (message.error) pending.reject(new CodexAppServerError(`Codex App Server rejected ${pending.method} (${message.error.code}): ${message.error.message}`));
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
      else this.fail(new CodexAppServerError(params.turn?.status === 'interrupted'
        ? 'The Codex turn was interrupted.'
        : `The Codex turn failed: ${params.turn?.error?.message ?? 'No error reason was returned.'} Command execution: ${this.transport!.executionId}.`));
    }
  }

  private async respond(message: RpcMessage): Promise<void> {
    this.request.signal.throwIfAborted();
    const params = message.params ?? {};
    if (message.method === 'item/tool/call') {
      if (this.questionOutput) {
        await this.send({ id: message.id, result: { contentItems: [{ type: 'inputText', text: 'The task is waiting for the user.' }], success: false } });
        return;
      }
      if (params.threadId !== this.threadId || (this.turnId && params.turnId !== this.turnId) || params.namespace || !this.request.tools.some((tool) => tool.name === params.tool)) {
        throw new CodexAppServerError('Codex requested a tool outside the captured WorkLite invocation.');
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
    await this.send({ id: message.id, error: { code: -32601, message: 'This request is unavailable in WorkLite execution.' } });
    throw new CodexAppServerError('Codex requested an unsupported client capability.');
  }

  private send(message: unknown): Promise<void> {
    if (!this.transport) return Promise.reject(new Error('Codex App Server transport is unavailable.'));
    return this.transport.write(`${JSON.stringify(message)}\n`);
  }
}

function appServerArguments(request: CodexInvocation, disabledMcp: Record<string, unknown>): string[] {
  const config: Record<string, unknown> = {
    ...request.launch.settings,
    mcp_servers: disabledMcp,
    model: request.publicModelId,
    approval_policy: 'never',
    sandbox_mode: 'danger-full-access',
    web_search: 'disabled',
    notify: [],
    'features.shell_tool': false,
    'features.hooks': false,
    'features.plugins': false,
    'features.multi_agent': false,
    'features.multi_agent_v2': false,
    'features.apps': false,
    'features.code_mode': false,
    'features.image_generation': false,
    'features.skill_mcp_dependency_install': false,
    ...(request.launch.mode === 'cx' ? {
      [`model_providers.${request.launch.modelProvider}.http_headers`]: {
        'x-worklite-log-source': request.owner ?? 'team',
        ...(request.correlation?.teamRunId ? { 'x-worklite-team-run-id': request.correlation.teamRunId } : {}),
        ...(request.correlation?.teamTaskAttemptId ? { 'x-worklite-team-task-attempt-id': request.correlation.teamTaskAttemptId } : {}),
      },
    } : {}),
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
  if (!match || (Number(match[1]) === 0 && (Number(match[2]) < 157 || (Number(match[2]) === 157 && Number(match[3]) < 1)))) {
    throw new CodexAppServerError(`Codex 版本 ${match?.[0] ?? '未知'} 不支持此执行协议；需要 0.157.1 或更高版本。`);
  }
}
