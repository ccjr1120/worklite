import { validateModelParameters } from '@worklite/contracts';
import { BadRequestException, Injectable } from '@nestjs/common';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parse as parseToml, type TomlTable } from 'smol-toml';
import type { StoredProjectExecutorLaunch } from '@worklite/db';
import { gatewayAttributionHeaders } from '@worklite/model-gateway';
import { CommandsService, type CommandStdioProcess } from '../commands/commands.service';
import { settleRuntimeInterruption } from './runtime-interruption';
import { requireSafeCommandWord, isGatewayPublicModel, localGatewayBaseUrl, type AgentRuntimeAdapter, type PreparedProjectExecution, type ProjectExecutorActivity, type ProjectExecutorRequest } from './project-executor.types';

type CodexLaunch = Extract<StoredProjectExecutorLaunch, { executor: 'codex' }>;

export class CodexAppServerError extends Error {}

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code: number; message: string };
};

// Codex App Server is a built-in runtime. New sessions always launch `codex` and use
// its local configuration; Gateway models receive a per-run Responses Provider override.
// Protocol verified against openai/codex rust-v0.163.0.
const LOGIN_SHELL = '/bin/zsh';
const GATEWAY_MODEL_PROVIDER = 'worklite';
const GATEWAY_MODEL_API_KEY_ENV = 'WORKLITE_GATEWAY_API_KEY';

@Injectable()
export class CodexAppServerService implements AgentRuntimeAdapter {
  readonly capabilities = { resume: true, steer: true, liveQuestions: true, approvals: true } as const;
  constructor(private readonly commands: CommandsService) {}

  async captureLaunch(model: string | null): Promise<CodexLaunch> {
    return { executor: 'codex', commandArguments: ['codex'], model };
  }

  async execute(request: ProjectExecutorRequest, prepared: PreparedProjectExecution): Promise<string> {
    request.signal.throwIfAborted();
    const launch = request.launch as CodexLaunch;
    const parameters = validateModelParameters(request.modelParameters);
    if (Object.keys(parameters.requestBody ?? {}).length) throw new BadRequestException('Codex runtime supports reasoning effort and service tier; request JSON parameters require a native Agent.');
    const controller = new AbortController();
    const session = new CodexAppServerSession(request, (error) => controller.abort(error));
    let process: CommandStdioProcess | undefined;
    let completed = false;
    let closing = false;
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= (async () => {
        if (session.threadId && session.turnId) {
          await settleRuntimeInterruption(async () => {
            await session.call('turn/interrupt', { threadId: session.threadId, turnId: session.turnId });
            await session.waitForTurnEnd();
          });
        }
        session.fail(request.signal.reason ?? new Error('The Codex task was cancelled.'));
      })();
    };
    try {
      // A declared Gateway public model is served by the WorkLite Gateway through a per-run Responses
      // Provider; a native Codex model keeps the operator's own Codex configuration untouched.
      const model = request.model ?? launch.model;
      const gatewayModel = isGatewayPublicModel(model);
      const mcp = codexMcpServers(prepared, gatewayModel, attributionHeaders(request));
      if (parameters.reasoningEffort) mcp.config.model_reasoning_effort = parameters.reasoningEffort;
      if (parameters.serviceTier) mcp.config.service_tier = codexServiceTier(parameters.serviceTier);
      else if (await configuredFastTier(launch)) mcp.config.service_tier = 'priority';
      if (!gatewayModel) Object.assign(mcp.config, await nativeGatewayHeaderConfig(launch, attributionHeaders(request)));
      process = await this.commands.openStdioProcess(
        appServerArguments(launch, mcp.config, request.approvalPolicy), request.projectDirectory, mcp.env,
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
        clientInfo: { name: `worklite_${request.owner}`, title: 'WorkLite', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
      requireSupportedVersion(initialized.userAgent);
      await session.notify('initialized', {});
      if (prepared.skillRoot) await session.call('skills/extraRoots/set', { extraRoots: [prepared.skillRoot] });
      const started = await session.call(request.runtimeSession?.resumeId ? 'thread/resume' : 'thread/start', {
        ...(request.runtimeSession?.resumeId ? { threadId: request.runtimeSession.resumeId } : {}),
        ...(model ? { model } : {}),
        ...(gatewayModel ? { modelProvider: GATEWAY_MODEL_PROVIDER } : {}),
        cwd: request.projectDirectory,
        approvalPolicy: request.approvalPolicy === 'ask' ? 'on-request' : 'never',
        sandbox: request.approvalPolicy === 'ask' ? 'workspace-write' : 'danger-full-access',
        ...(!request.runtimeSession?.resumeId ? { ephemeral: !request.runtimeSession } : {}),
        developerInstructions: prepared.systemPrompt,
      });
      session.threadId = started.thread.id;
      await request.runtimeSession?.onSession(started.thread.id);
      await session.activity('codex.thread_started');
      const turn = await session.call('turn/start', {
        threadId: session.threadId,
        ...(parameters.reasoningEffort ? { effort: parameters.reasoningEffort } : {}),
        ...(parameters.serviceTier ? { serviceTier: codexServiceTier(parameters.serviceTier) } : {}),
        input: [{ type: 'text', text: request.input, text_elements: [] }],
      });
      session.turnId = turn.turn.id;
      await session.activity('codex.turn_started');
      if (request.steerPort) request.steerPort.deliver = (text) => session.steer(text);
      const output = await session.result();
      request.signal.throwIfAborted();
      closing = true;
      await process.close();
      const execution = await process.completion;
      if (execution.status !== 'succeeded') throw new Error('Codex App Server did not shut down successfully.');
      await session.activity('codex.completed');
      completed = true;
      return output;
    } catch (error) {
      request.signal.throwIfAborted();
      throw error;
    } finally {
      request.signal.removeEventListener('abort', cancel);
      await cancellation;
      controller.abort(new Error('The Codex App Server session is closed.'));
      try {
        if (process && !completed) {
          await this.commands.cancel(process.executionId);
          await process.completion;
        }
      } finally {
        // A failed/interrupted turn can arrive in the same stdout chunk as its last
        // usage update. Persist those queued observations before the caller settles.
        await session.flushEvents();
        session.fail(new Error('The Codex App Server session is closed.'));
      }
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
  private readonly items = new Map<string, Record<string, unknown>>();
  private failed?: unknown;
  private readonly pending = new Map<number | string, { method: string; resolve: (result: any) => void; reject: (error: unknown) => void }>();
  private requestQueue = Promise.resolve();
  private eventQueue = Promise.resolve();
  private lastUsage?: string;
  private readonly finished: Promise<string>;
  private readonly failure: Promise<never>;
  private rejectFailure!: (error: unknown) => void;
  private finish!: (text: string) => void;
  private reject!: (error: unknown) => void;

  constructor(private readonly request: ProjectExecutorRequest, private readonly onFailure: (error: unknown) => void) {
    this.finished = new Promise((resolve, reject) => { this.finish = resolve; this.reject = reject; });
    void this.finished.catch(() => undefined);
    this.failure = new Promise<never>((_resolve, reject) => { this.rejectFailure = reject; });
    void this.failure.catch(() => undefined);
  }

  attach(transport: CommandStdioProcess): void { this.transport = transport; }

  async flushEvents(): Promise<void> { await this.eventQueue; }

  async waitForTurnEnd(): Promise<void> { await this.finished.catch(() => undefined); }

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

  // Delivers a mid-run correction into the live turn through turn/steer. Returns false (never
  // throws) when the turn cannot accept it right now: no active turn, a stale expectedTurnId
  // raced against the turn's own completion, or a non-steerable turn kind (review/compact); the
  // caller then falls back to queuing the instruction for the task's next run.
  async steer(text: string): Promise<boolean> {
    if (this.failed || !this.threadId || !this.turnId) return false;
    try {
      const response = await this.call('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: this.turnId,
        input: [{ type: 'text', text, text_elements: [] }],
      });
      if (typeof response?.turnId === 'string') this.turnId = response.turnId;
      return true;
    } catch {
      return false;
    }
  }

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
    this.rejectFailure(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.reject(error);
  }

  async result(): Promise<string> {
    const text = await this.finished;
    await Promise.race([this.requestQueue, this.failure]);
    await Promise.race([this.eventQueue, this.failure]);
    if (this.failed) throw this.failed;
    if (!text.trim() && !(this.request.owner === 'chat' && this.request.runtimeSession)) throw new Error('Codex App Server returned an empty task result.');
    return text.trim();
  }

  activity(phase: string, item?: Record<string, any>): Promise<void> {
    const summary = item ? codexItemSummary(item) : undefined;
    const activity: ProjectExecutorActivity = {
      phase,
      commandExecutionId: this.transport!.executionId,
      ...(this.threadId ? { threadId: this.threadId } : {}),
      ...(this.turnId ? { turnId: this.turnId } : {}),
      ...(typeof item?.id === 'string' ? { itemId: item.id } : {}),
      ...(typeof item?.type === 'string' ? { itemType: item.type } : {}),
      ...(summary ? { summary } : {}),
      ...(phase === 'codex.item_completed' ? { status: item?.status === 'failed' || item?.status === 'declined' || (typeof item?.exitCode === 'number' && item.exitCode !== 0) ? 'failed' as const : 'completed' as const } : {}),
      ...(phase === 'codex.item_completed' && item?.type === 'agentMessage' && typeof item.text === 'string' ? { text: item.text } : {}),
    };
    return Promise.resolve(this.request.onEvent?.(activity));
  }

  private receive(message: RpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new CodexAppServerError(`Codex App Server rejected ${pending.method} (${message.error.code}): ${message.error.message}`));
      else {
        // Notifications can follow the response in the same stdout chunk, before
        // the awaiting execute() continuation has a chance to bind these ids.
        if ((pending.method === 'thread/start' || pending.method === 'thread/resume') && typeof message.result?.thread?.id === 'string') this.threadId = message.result.thread.id;
        if (pending.method === 'turn/start' && typeof message.result?.turn?.id === 'string') this.turnId = message.result.turn.id;
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      this.requestQueue = this.requestQueue.then(() => {
        if (this.failed) return;
        return this.respond(message);
      }).catch((error) => this.fail(error));
      return;
    }
    const params = message.params ?? {};
    if (this.threadId && params.threadId && params.threadId !== this.threadId) return;
    if (message.method === 'thread/tokenUsage/updated' && params.tokenUsage?.total) {
      // `total` is a thread snapshot (including resumed turns), not a delta.
      // Cache and reasoning counters are already included in input/output.
      const usage = codexTokenUsage(params.tokenUsage.total);
      const snapshot = JSON.stringify(usage);
      if (usage && snapshot !== this.lastUsage) {
        this.lastUsage = snapshot;
        const activity: ProjectExecutorActivity = { phase: 'codex.usage', usage, commandExecutionId: this.transport!.executionId,
          threadId: params.threadId ?? this.threadId, turnId: params.turnId ?? this.turnId };
        this.eventQueue = this.eventQueue.then(() => this.request.onEvent?.(activity)).then(() => undefined).catch((error) => this.fail(error));
      }
    }
    if (message.method === 'turn/plan/updated' && Array.isArray(params.plan)) {
      const plan = params.plan.flatMap((entry: { step?: unknown; status?: unknown }) => {
        const status = entry.status === 'inProgress' ? 'in_progress' : entry.status;
        return typeof entry.step === 'string' && ['pending', 'in_progress', 'completed'].includes(String(status))
          ? [{ step: entry.step, status: status as 'pending' | 'in_progress' | 'completed' }] : [];
      });
      this.eventQueue = this.eventQueue.then(() => this.request.onEvent?.({ phase: 'codex.plan_updated', plan })).then(() => undefined).catch((error) => this.fail(error));
    }
    if (message.method === 'turn/started') this.turnId = params.turn?.id;
    if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      this.eventQueue = this.eventQueue.then(() => this.request.onTextDelta?.(params.delta)).then(() => undefined).catch((error) => this.fail(error));
    }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      if (typeof params.item?.id === 'string') this.items.set(params.item.id, params.item);
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
    // Existing tasks retain direct execution; interactive Agents can route native approvals to the owner.
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
      const allowed = this.request.approvalPolicy !== 'ask' || await this.request.onApproval?.(codexApprovalDescription(message.method, params, typeof params.itemId === 'string' ? this.items.get(params.itemId) : undefined));
      this.request.signal.throwIfAborted();
      await this.send({ id: message.id, result: { decision: allowed ? 'accept' : 'decline' } });
      return;
    }
    if (message.method === 'item/permissions/requestApproval') {
      const allowed = this.request.approvalPolicy !== 'ask' || await this.request.onApproval?.(`Codex requests additional filesystem or network permissions:\n${JSON.stringify(params.permissions ?? {}, null, 2)}`);
      this.request.signal.throwIfAborted();
      await this.send({ id: message.id, result: { permissions: allowed ? params.permissions ?? {} : {}, scope: 'turn' } });
      return;
    }
    if (message.method === 'item/tool/requestUserInput') {
      const questions = Array.isArray(params.questions) ? params.questions.map((item: { question?: string }) => item.question).filter(Boolean) : [];
      if (questions.length === 0) throw new Error('Codex returned a user question without question text.');
      if (this.request.onQuestion) {
        const answers: Record<string, { answers: string[] }> = {};
        for (const question of params.questions as Array<{ id: string; question: string; options?: Array<{ label: string }> }>) {
          if (typeof question.id !== 'string' || typeof question.question !== 'string') throw new Error('Codex returned an invalid user question.');
          const choices = question.options?.map((option) => option.label).join(', ');
          const answer = await this.request.onQuestion(choices ? `${question.question}\n${choices}` : question.question);
          this.request.signal.throwIfAborted();
          if (answer === undefined) throw new Error('The Codex question was cancelled.');
          answers[question.id] = { answers: [answer] };
        }
        await this.send({ id: message.id, result: { answers } });
        return;
      }
      this.questionOutput = JSON.stringify({ status: 'waiting_for_input', pendingInput: { question: questions.join('\n') } });
      await this.send({ id: message.id, result: { answers: {} } });
      await this.call('turn/interrupt', { threadId: this.threadId, turnId: params.turnId });
      this.finish(this.questionOutput);
      return;
    }
    await this.send({ id: message.id, error: { code: -32601, message: 'This request is unavailable in WorkLite execution.' } });
  }

  private send(message: unknown): Promise<void> {
    if (!this.transport) return Promise.reject(new Error('Codex App Server transport is unavailable.'));
    return this.transport.write(`${JSON.stringify(message)}\n`);
  }
}

function codexTokenUsage(total: Record<string, unknown>): ProjectExecutorActivity['usage'] {
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const inputTokens = count(total.inputTokens);
  const outputTokens = count(total.outputTokens);
  const totalTokens = count(total.totalTokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  if (inputTokens === null && outputTokens === null && totalTokens === null) return undefined;
  return { inputTokens, outputTokens, totalTokens, cacheReadTokens: count(total.cachedInputTokens), cacheCreationTokens: count(total.cacheWriteInputTokens) };
}

// Selected MCP servers join the operator's own servers; bearer tokens travel through the process environment.
// A Gateway-selected model also adds a per-run Responses Provider pointing at the local Gateway, so Codex sends
// the public `<provider>/<model>` id there instead of requiring it in the operator's own Codex catalog.
/**
 * Codex only reaches the Gateway through the per-run Responses Provider below, and it
 * sends nothing WorkLite-specific of its own, so without these configured headers the
 * executor's traffic arrives unattributed. Native configuration is also inspected
 * for local Gateway Providers. Direct-provider traffic is recorded only by the
 * runtime's token events, not by Gateway statistics.
 */
export function attributionHeaders(request: ProjectExecutorRequest): Record<string, string> {
  const correlation = request.correlation
    ?? { surface: request.owner === 'agent' ? 'agent' as const : request.owner === 'coder' ? 'coder_project_task' as const : 'chat_project_task' as const };
  return gatewayAttributionHeaders({ ...correlation, executor: 'codex' });
}

export function codexMcpServers(prepared: PreparedProjectExecution, gatewayModel: boolean, gatewayHeaders: Record<string, string> = {}): { config: Record<string, unknown>; env: Record<string, string> } {
  const config: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  prepared.mcpServers.forEach((server, index) => {
    const tokenVariable = `WORKLITE_MCP_TOKEN_${index}`;
    if (server.authToken) env[tokenVariable] = server.authToken;
    config[`mcp_servers.${server.key}`] = {
      url: server.endpoint,
      enabled_tools: server.allowedTools,
      ...(server.authToken ? { bearer_token_env_var: tokenVariable } : {}),
    };
  });
  if (gatewayModel) {
    config.model_provider = GATEWAY_MODEL_PROVIDER;
    config[`model_providers.${GATEWAY_MODEL_PROVIDER}`] = {
      name: 'WorkLite Gateway',
      base_url: `${localGatewayBaseUrl()}/v1`,
      wire_api: 'responses',
      env_key: GATEWAY_MODEL_API_KEY_ENV,
      ...(Object.keys(gatewayHeaders).length > 0 ? { http_headers: gatewayHeaders } : {}),
    };
    // Codex requires the configured key variable to be present; the Gateway resolves the real Provider credential.
    env[GATEWAY_MODEL_API_KEY_ENV] = 'worklite';
    // The ChatGPT apps connector (Figma, Sites, ...) adds ~55k tokens of tool definitions to every request and
    // fills a Gateway model's context early, forcing slow client-side compactions. Forcing `code_mode_only` was
    // measured too: deepseek-class models made more round trips with it, so the classic tools stay.
    config['features.apps'] = false;
  }
  return { config, env };
}

// Retain captured launches for existing sessions; new sessions use the built-in codex command.
// Validate historical command words before interpolating them into the login shell script.
function appServerArguments(launch: CodexLaunch, mcpServers: Record<string, unknown>, approvalPolicy?: 'auto' | 'ask'): string[] {
  const [word, ...fixedArguments] = launch.commandArguments;
  requireSafeCommandWord(word);
  const config: Record<string, unknown> = {
    ...mcpServers,
    approval_policy: approvalPolicy === 'ask' ? 'on-request' : 'never',
    sandbox_mode: approvalPolicy === 'ask' ? 'workspace-write' : 'danger-full-access',
  };
  const configDirectoryArguments = launch.configDirectory ? ['--config-dir', launch.configDirectory] : [];
  const trailingArguments = [...configDirectoryArguments, ...fixedArguments, ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${tomlValue(value)}`]), 'app-server', '--listen', 'stdio://'];
  return [LOGIN_SHELL, '-ic', `${word} "$@"`, '--', ...trailingArguments];
}

// Native Codex configuration can itself point at WorkLite. Add only attribution
// keys as per-process overrides; never copy credentials into the command or edit config.toml.
async function nativeGatewayHeaderConfig(launch: CodexLaunch, headers: Record<string, string>): Promise<Record<string, string>> {
  const directory = launch.configDirectory ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  let content: string;
  try { content = await readFile(join(directory, 'config.toml'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new BadRequestException('Cannot read the native Codex configuration for Gateway attribution.'); }
  let config: TomlTable;
  try { config = parseToml(content); }
  catch { throw new BadRequestException('Cannot parse the native Codex configuration for Gateway attribution.'); }
  const providers = config.model_providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return {};
  const result: Record<string, string> = {};
  for (const [id, value] of Object.entries(providers)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const base = (value as Record<string, unknown>).base_url;
    if (typeof base !== 'string') continue;
    let url: URL;
    try { url = new URL(base); } catch { continue; }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || ![23390, 23391, Number(process.env.PORTKEY_GATEWAY_PORT ?? 23392)].includes(Number(url.port))) continue;
    // Codex's -c key paths use dot-separated map keys, not quoted TOML paths.
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new BadRequestException('Native Gateway Provider attribution requires a provider id containing only letters, digits, underscores or hyphens.');
    for (const [name, header] of Object.entries(headers)) result[`model_providers.${id}.http_headers.${name}`] = header;
  }
  return result;
}

function tomlValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  return `{ ${Object.entries(value as Record<string, unknown>).map(([key, entry]) => `${JSON.stringify(key)} = ${tomlValue(entry)}`).join(', ')} }`;
}

function codexItemSummary(item: Record<string, any>): string | undefined {
  if (item.type === 'commandExecution' && typeof item.command === 'string') {
    return [item.command, typeof item.exitCode === 'number' ? `exit ${item.exitCode}` : ''].filter(Boolean).join(' · ');
  }
  if (item.type === 'fileChange' && Array.isArray(item.changes)) {
    return item.changes.map((change: { path?: unknown }) => change.path).filter((path: unknown): path is string => typeof path === 'string').join(', ') || undefined;
  }
  if (item.type === 'mcpToolCall' && typeof item.tool === 'string') return [item.server, item.tool].filter((part) => typeof part === 'string').join(' · ');
  if (item.type === 'webSearch' && typeof item.query === 'string') return item.query;
  if (item.type === 'imageView' && typeof item.path === 'string') return item.path;
  if (item.type === 'dynamicToolCall' && typeof item.tool === 'string') return item.tool;
  return undefined;
}

function requireSupportedVersion(userAgent: unknown): void {
  const match = typeof userAgent === 'string' ? userAgent.match(/\b(\d+)\.(\d+)\.(\d+)\b/) : null;
  if (!match || (Number(match[1]) === 0 && (Number(match[2]) < 157 || (Number(match[2]) === 157 && Number(match[3]) < 1)))) {
    throw new CodexAppServerError(`Codex 版本 ${match?.[0] ?? '未知'} 不支持此执行协议；需要 0.157.1 或更高版本。`);
  }
}

export { LOGIN_SHELL };

function codexApprovalDescription(method: string, params: Record<string, unknown>, item?: Record<string, unknown>): string {
  const description = method === 'item/commandExecution/requestApproval' ? 'execute a command' : 'change files';
  const command = typeof params.command === 'string' ? params.command : undefined;
  const reason = typeof params.reason === 'string' ? params.reason : undefined;
  const changes = item?.changes ? JSON.stringify(item.changes, null, 2) : undefined;
  const grantRoot = typeof params.grantRoot === 'string' ? `Requested root: ${params.grantRoot}` : undefined;
  return [`Codex requests permission to ${description}.`, command, changes, grantRoot, reason].filter(Boolean).join('\n');
}

// Codex's fast UI setting must use the Responses wire value; ChatGPT rejects literal "fast".
export function codexServiceTier(value: string): string { return value === 'fast' ? 'priority' : value; }

async function configuredFastTier(launch: CodexLaunch): Promise<boolean> {
  const directory = launch.configDirectory ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  try {
    const config = parseToml(await readFile(join(directory, 'config.toml'), 'utf8'));
    const profile = typeof config.profile === 'string' && config.profiles && typeof config.profiles === 'object'
      ? (config.profiles as Record<string, TomlTable>)[config.profile] : undefined;
    return (profile?.service_tier ?? config.service_tier) === 'fast';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new BadRequestException('Cannot read the native Codex service tier configuration.');
  }
}
