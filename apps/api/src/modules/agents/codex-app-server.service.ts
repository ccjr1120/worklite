import { Injectable } from '@nestjs/common';
import type { StoredProjectExecutorLaunch } from '@worklite/db';
import { CommandsService, type CommandStdioProcess } from '../commands/commands.service';
import { requireSafeCommandWord, type PreparedProjectExecution, type ProjectExecutorActivity, type ProjectExecutorRequest } from './project-executor.types';

type CodexLaunch = Extract<StoredProjectExecutorLaunch, { executor: 'codex' }>;

export class CodexAppServerError extends Error {}

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code: number; message: string };
};

// Codex's configured command word (e.g. `cxo`, `cx`, `codex`) is launched through the operator's own
// interactive zsh login shell, exactly like a manual terminal invocation: this resolves ~/.zshrc aliases,
// functions and PATH the same way the operator's own shell would, so whatever local Codex configuration
// (home directory, model, Provider) that resolution selects is what runs. WorkLite names no Codex config
// file or directory here and does not require the resolved model or Provider to exist in the WorkLite
// Gateway. Protocol verified against openai/codex rust-v0.163.0.
const LOGIN_SHELL = '/bin/zsh';

@Injectable()
export class CodexAppServerService {
  constructor(private readonly commands: CommandsService) {}

  async captureLaunch(commandArguments: readonly string[], model: string | null): Promise<CodexLaunch> {
    requireSafeCommandWord(commandArguments[0]);
    return { executor: 'codex', commandArguments: [...commandArguments], model };
  }

  async execute(request: ProjectExecutorRequest, prepared: PreparedProjectExecution): Promise<string> {
    request.signal.throwIfAborted();
    const launch = request.launch as CodexLaunch;
    const controller = new AbortController();
    const session = new CodexAppServerSession(request, (error) => controller.abort(error));
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
      const mcp = codexMcpServers(prepared);
      process = await this.commands.openStdioProcess(
        appServerArguments(launch, mcp.config), request.projectDirectory, mcp.env,
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
      const model = request.model ?? launch.model;
      const started = await session.call('thread/start', {
        ...(model ? { model } : {}),
        cwd: request.projectDirectory,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        ephemeral: true,
        developerInstructions: prepared.systemPrompt,
      });
      session.threadId = started.thread.id;
      await session.activity('codex.thread_started');
      const turn = await session.call('turn/start', {
        threadId: session.threadId,
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
    } finally {
      request.signal.removeEventListener('abort', cancel);
      controller.abort(new Error('The Codex App Server session is closed.'));
      if (process && !completed) {
        await this.commands.cancel(process.executionId);
        await process.completion;
      }
      session.fail(new Error('The Codex App Server session is closed.'));
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
  private readonly pending = new Map<number | string, { method: string; resolve: (result: any) => void; reject: (error: unknown) => void }>();
  private requestQueue = Promise.resolve();
  private eventQueue = Promise.resolve();
  private readonly finished: Promise<string>;
  private finish!: (text: string) => void;
  private reject!: (error: unknown) => void;

  constructor(private readonly request: ProjectExecutorRequest, private readonly onFailure: (error: unknown) => void) {
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
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.reject(error);
  }

  async result(): Promise<string> {
    const text = await this.finished;
    await this.requestQueue;
    await this.eventQueue;
    if (this.failed) throw this.failed;
    if (!text.trim()) throw new Error('Codex App Server returned an empty task result.');
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
      else pending.resolve(message.result);
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
    // The approval policy is never, so approvals are not expected; any that arrive are accepted like the operator's cx alias.
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
      await this.send({ id: message.id, result: { decision: 'accept' } });
      return;
    }
    if (message.method === 'item/permissions/requestApproval') {
      await this.send({ id: message.id, result: { permissions: params.permissions ?? {}, scope: 'turn' } });
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
  }

  private send(message: unknown): Promise<void> {
    if (!this.transport) return Promise.reject(new Error('Codex App Server transport is unavailable.'));
    return this.transport.write(`${JSON.stringify(message)}\n`);
  }
}

// Selected MCP servers join the operator's own servers; bearer tokens travel through the process environment.
function codexMcpServers(prepared: PreparedProjectExecution): { config: Record<string, unknown>; env: Record<string, string> } {
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
  return { config, env };
}

// Launches the configured command word through the operator's interactive zsh so it resolves exactly like
// typing it in a terminal (aliases, functions, PATH). The word is interpolated unquoted into the inline script
// specifically so shell alias expansion applies (quoting it would defeat that); SAFE_COMMAND_WORD in
// captureLaunch rejects anything containing shell syntax before it reaches here. Everything after the word is
// forwarded as real argv elements through "$@", never interpolated into the script text.
function appServerArguments(launch: CodexLaunch, mcpServers: Record<string, unknown>): string[] {
  const [word, ...fixedArguments] = launch.commandArguments;
  const config: Record<string, unknown> = {
    ...mcpServers,
    approval_policy: 'never',
    sandbox_mode: 'danger-full-access',
  };
  const trailingArguments = [...fixedArguments, ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${tomlValue(value)}`]), 'app-server', '--listen', 'stdio://'];
  return [LOGIN_SHELL, '-ic', `${word} "$@"`, '--', ...trailingArguments];
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
  return undefined;
}

function requireSupportedVersion(userAgent: unknown): void {
  const match = typeof userAgent === 'string' ? userAgent.match(/\b(\d+)\.(\d+)\.(\d+)\b/) : null;
  if (!match || (Number(match[1]) === 0 && (Number(match[2]) < 157 || (Number(match[2]) === 157 && Number(match[3]) < 1)))) {
    throw new CodexAppServerError(`Codex 版本 ${match?.[0] ?? '未知'} 不支持此执行协议；需要 0.157.1 或更高版本。`);
  }
}

export { LOGIN_SHELL };
