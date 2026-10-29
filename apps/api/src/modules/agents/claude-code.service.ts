import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StoredProjectExecutorLaunch } from '@worklite/db';
import { gatewayAttributionHeaders } from '@worklite/model-gateway';
import { CommandsService, type CommandStdioProcess } from '../commands/commands.service';
import { McpClientService } from '../mcp-servers/mcp-client.service';
import { requireGatewayUrl, isGatewayPublicModel, localGatewayBaseUrl, type PreparedProjectExecution, type ProjectExecutorActivity, type ProjectExecutorRequest } from './project-executor.types';

type ClaudeLaunch = Extract<StoredProjectExecutorLaunch, { executor: 'claude' }>;

export class ClaudeCodeError extends Error {}

type StreamMessage = Record<string, any> & { type?: string };

// Claude Code runs headless through `claude -p` with stream-json input and output and the control protocol used by
// the official Agent SDK (anthropics/claude-agent-sdk-python a8e7ce3, _internal/transport/subprocess_cli.py and
// _internal/query.py). It keeps its native tools and the operator's ~/.claude configuration; WorkLite answers only
// permission prompts and records the message stream as evidence.
@Injectable()
export class ClaudeCodeService {
  constructor(private readonly commands: CommandsService, private readonly mcp: McpClientService) {}

  async captureLaunch(commandArguments: readonly string[], model: string | null): Promise<ClaudeLaunch> {
    // A declared Gateway model is served by the WorkLite Gateway itself; the operator's own Claude Code
    // base URL (including whatever a provider switcher left in ~/.claude/settings.json) is irrelevant then.
    if (isGatewayPublicModel(model)) {
      return { executor: 'claude', commandArguments: [...commandArguments], baseUrl: localGatewayBaseUrl(), model };
    }
    let settingsEnv: Record<string, unknown> = {};
    try {
      const settings = JSON.parse(await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8')) as { env?: Record<string, unknown> };
      settingsEnv = settings.env ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BadRequestException('无法读取 ~/.claude/settings.json。');
    }
    // A settings env block overrides the inherited process environment, matching Claude Code's own precedence.
    const baseUrl = requireGatewayUrl(settingsEnv.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_BASE_URL, 'Claude Code 的 ANTHROPIC_BASE_URL ');
    return { executor: 'claude', commandArguments: [...commandArguments], baseUrl, model };
  }

  async execute(request: ProjectExecutorRequest, prepared: PreparedProjectExecution): Promise<string> {
    request.signal.throwIfAborted();
    const launch = request.launch as ClaudeLaunch;
    const controller = new AbortController();
    const session = new ClaudeCodeSession(request, (error) => controller.abort(error));
    let process: CommandStdioProcess | undefined;
    let completed = false;
    let closing = false;
    const cancel = () => {
      void session.control({ subtype: 'interrupt' }).catch(() => undefined);
      session.fail(request.signal.reason ?? new Error('The Claude Code task was cancelled.'));
      if (process) void this.commands.cancel(process.executionId).catch(() => undefined);
    };
    try {
      const promptFile = join(prepared.directory, 'system-prompt.md');
      await writeFile(promptFile, prepared.systemPrompt, { mode: 0o600 });
      const mcp = await this.mcpArguments(prepared, request.signal);
      const model = request.model ?? launch.model;
      // `~/.claude/settings.json` env overrides the inherited process environment, so a Gateway-selected
      // model is routed through a per-task `--settings` file instead of child-process environment variables.
      const gatewayModel = isGatewayPublicModel(model);
      let gatewayArguments: string[] = [];
      if (gatewayModel) {
        const settingsFile = join(prepared.directory, 'claude-gateway-settings.json');
        await writeFile(settingsFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: localGatewayBaseUrl(), ANTHROPIC_AUTH_TOKEN: 'worklite' } }), { mode: 0o600 });
        gatewayArguments = ['--settings', settingsFile];
      }
      const argv = [
        ...launch.commandArguments,
        '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--permission-mode', 'bypassPermissions', '--permission-prompt-tool', 'stdio', '--no-session-persistence',
        '--append-system-prompt-file', promptFile,
        ...(model ? ['--model', model] : []),
        ...gatewayArguments,
        ...(prepared.pluginDirectory ? ['--plugin-dir', prepared.pluginDirectory] : []),
        ...mcp,
      ];
      process = await this.commands.openStdioProcess(argv, request.projectDirectory, { ANTHROPIC_CUSTOM_HEADERS: correlationHeaders(request) }, (event) => {
        if (event.type === 'stdout') session.consume(event.data);
      });
      session.attach(process);
      void process.completion.then(() => {
        if (!closing) session.fail(new Error('Claude Code stopped before completing its task.'));
      }, (error) => session.fail(error));
      request.signal.addEventListener('abort', cancel, { once: true });
      if (request.signal.aborted) { cancel(); request.signal.throwIfAborted(); }
      await session.activity('claude.started');
      await session.control({ subtype: 'initialize', hooks: null });
      await session.send({ type: 'user', message: { role: 'user', content: request.input }, parent_tool_use_id: null, session_id: 'default' });
      const output = await session.result();
      request.signal.throwIfAborted();
      closing = true;
      await process.close();
      const execution = await process.completion;
      if (execution.status !== 'succeeded' && !session.asked) throw new Error('Claude Code did not shut down successfully.');
      await session.activity('claude.completed');
      completed = true;
      return output;
    } finally {
      request.signal.removeEventListener('abort', cancel);
      controller.abort(new Error('The Claude Code session is closed.'));
      if (process && !completed) {
        await this.commands.cancel(process.executionId);
        await process.completion;
      }
      session.fail(new Error('The Claude Code session is closed.'));
    }
  }

  // Selected MCP servers are added to the operator's own through an owner-only config file, never through argv.
  // Claude Code has no per-server tool allowlist, so tools outside the captured allowlist are disallowed by name.
  private async mcpArguments(prepared: PreparedProjectExecution, signal: AbortSignal): Promise<string[]> {
    return writeClaudeMcpConfiguration(prepared.directory, prepared.mcpServers, (server) => this.mcp.discover(
      { endpoint: server.endpoint, ...(server.authToken ? { authToken: server.authToken } : {}) },
      signal,
    ));
  }
}

const mcpLogger = new Logger('ClaudeCodeMcp');

/**
 * Writes the owner-only mcp.json and returns the Claude Code argv fragment. A server
 * whose discovery fails is skipped rather than injected unvetted, but the failure is
 * logged: silently dropping the WorkLite executor category memory server would hide its tools.
 */
export async function writeClaudeMcpConfiguration(
  directory: string,
  servers: ReadonlyArray<{ key: string; endpoint: string; authToken?: string; allowedTools: string[] }>,
  discover: (server: { key: string; endpoint: string; authToken?: string }) => Promise<Array<{ name: string }>>,
): Promise<string[]> {
  const configured: Record<string, unknown> = {};
  const disallowed: string[] = [];
  for (const server of servers) {
    let tools: Array<{ name: string }>;
    try {
      tools = await discover(server);
    } catch (error) {
      mcpLogger.warn(`MCP server ${server.key} could not be discovered and was not injected into Claude Code: ${error instanceof Error ? error.message : 'unknown error'}`);
      continue;
    }
    configured[server.key] = { type: 'http', url: server.endpoint, ...(server.authToken ? { headers: { Authorization: `Bearer ${server.authToken}` } } : {}) };
    disallowed.push(...tools.filter((tool) => !server.allowedTools.includes(tool.name)).map((tool) => `mcp__${server.key}__${tool.name}`));
  }
  if (Object.keys(configured).length === 0) return [];
  const file = join(directory, 'mcp.json');
  await writeFile(file, JSON.stringify({ mcpServers: configured }), { mode: 0o600 });
  return ['--mcp-config', file, ...(disallowed.length ? ['--disallowedTools', ...disallowed] : [])];
}

class ClaudeCodeSession {
  asked = false;
  private sessionId?: string;
  private transport?: CommandStdioProcess;
  private sequence = 0;
  private buffer = '';
  private text = '';
  private questionOutput?: string;
  private failed?: unknown;
  private readonly toolNames = new Map<string, string>();
  private readonly pending = new Map<string, { subtype: string; resolve: (result: any) => void; reject: (error: unknown) => void }>();
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

  async control(request: Record<string, unknown>): Promise<any> {
    if (this.failed) throw this.failed;
    const id = `worklite_${++this.sequence}`;
    const result = new Promise((resolve, reject) => this.pending.set(id, { subtype: String(request.subtype), resolve, reject }));
    void result.catch(() => undefined);
    try { await this.send({ type: 'control_request', request_id: id, request }); }
    catch (error) { this.fail(error); }
    return result;
  }

  send(message: unknown): Promise<void> {
    if (!this.transport) return Promise.reject(new Error('Claude Code transport is unavailable.'));
    return this.transport.write(`${JSON.stringify(message)}\n`);
  }

  consume(data: string): void {
    this.buffer += data;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try { this.receive(JSON.parse(line) as StreamMessage); }
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
    if (!text.trim()) throw new Error('Claude Code returned an empty task result.');
    return text.trim();
  }

  activity(phase: string, detail: Partial<ProjectExecutorActivity> = {}): Promise<void> {
    return Promise.resolve(this.request.onEvent?.({
      phase,
      commandExecutionId: this.transport!.executionId,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...detail,
    }));
  }

  private queueActivity(phase: string, detail: Partial<ProjectExecutorActivity>): void {
    this.eventQueue = this.eventQueue.then(() => this.activity(phase, detail)).catch((error) => this.fail(error));
  }

  private receive(message: StreamMessage): void {
    if (message.type === 'control_response') {
      const response = message.response ?? {};
      const pending = this.pending.get(response.request_id);
      if (!pending) return;
      this.pending.delete(response.request_id);
      if (response.subtype === 'error') pending.reject(new ClaudeCodeError(`Claude Code rejected ${pending.subtype}: ${response.error ?? 'No reason was returned.'}`));
      else pending.resolve(response.response);
      return;
    }
    if (message.type === 'control_request') {
      this.requestQueue = this.requestQueue.then(() => {
        if (this.failed) return;
        return this.respond(message.request_id, message.request ?? {});
      }).catch((error) => this.fail(error));
      return;
    }
    if (message.type === 'system' && message.subtype === 'init') {
      this.sessionId = typeof message.session_id === 'string' ? message.session_id : undefined;
      try { requireSupportedVersion(message.claude_code_version); }
      catch (error) { this.fail(error); return; }
      this.queueActivity('claude.session_started', {});
      return;
    }
    const topLevel = message.parent_tool_use_id == null;
    if (message.type === 'stream_event' && topLevel) {
      const event = message.event ?? {};
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        const delta = event.delta.text as string;
        this.eventQueue = this.eventQueue.then(() => this.request.onTextDelta?.(delta)).then(() => undefined).catch((error) => this.fail(error));
      }
      return;
    }
    if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        if (block?.type === 'text' && topLevel && typeof block.text === 'string') {
          this.text = block.text;
          this.queueActivity('claude.agent_message', { itemType: 'agent_message', text: block.text });
        }
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          this.toolNames.set(block.id, String(block.name));
          const summary = toolSummary(String(block.name), block.input);
          this.queueActivity('claude.tool_started', { itemId: block.id, itemType: String(block.name), ...(summary ? { summary } : {}) });
        }
      }
      return;
    }
    if (message.type === 'user' && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const itemType = this.toolNames.get(block.tool_use_id);
        this.queueActivity('claude.tool_completed', { itemId: block.tool_use_id, ...(itemType ? { itemType } : {}), ...(block.is_error ? { summary: 'error' } : {}) });
      }
      return;
    }
    if (message.type === 'result') {
      if (this.questionOutput) this.finish(this.questionOutput);
      else if (message.subtype === 'success' && !message.is_error) this.finish(typeof message.result === 'string' && message.result.trim() ? message.result : this.text);
      else {
        const errors = Array.isArray(message.errors) ? `: ${message.errors.join('; ')}` : typeof message.result === 'string' && message.result ? `: ${message.result}` : '';
        this.fail(new ClaudeCodeError(`The Claude Code turn failed (${message.subtype ?? 'unknown'})${errors}. Command execution: ${this.transport!.executionId}.`));
      }
    }
  }

  private async respond(requestId: string, request: Record<string, any>): Promise<void> {
    if (request.subtype === 'can_use_tool') {
      // AskUserQuestion becomes the task's pending question; every other tool keeps bypassPermissions behavior.
      if (request.tool_name === 'AskUserQuestion') {
        const questions = Array.isArray(request.input?.questions)
          ? request.input.questions.map((item: { question?: unknown }) => item.question).filter((question: unknown): question is string => typeof question === 'string' && !!question.trim())
          : [];
        if (questions.length === 0) throw new Error('Claude Code returned a user question without question text.');
        this.asked = true;
        this.questionOutput = JSON.stringify({ status: 'waiting_for_input', pendingInput: { question: questions.join('\n') } });
        await this.reply(requestId, { behavior: 'deny', message: 'WorkLite forwarded this question to the user. Stop and wait for the answer.', interrupt: true });
        return;
      }
      await this.reply(requestId, { behavior: 'allow', updatedInput: request.input ?? {} });
      return;
    }
    await this.send({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `${String(request.subtype)} is unavailable in WorkLite execution.` } });
  }

  private reply(requestId: string, response: unknown): Promise<void> {
    return this.send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }
}

/**
 * Claude Code sends these with every request it makes to its configured Anthropic base
 * URL, which is the WorkLite Gateway. Without them the executor's traffic reaches the
 * Gateway with no attribution and lands in the 'unattributed' group, so the full
 * correlation is rendered here rather than only the Team fields.
 */
function correlationHeaders(request: ProjectExecutorRequest): string {
  const correlation = request.correlation
    ?? { surface: request.owner === 'executor_category' ? 'executor_category_project_task' as const : 'chat_project_task' as const, executor: 'claude' as const };
  return Object.entries(gatewayAttributionHeaders(correlation)).map(([name, value]) => `${name}: ${value}`).join('\n');
}

function toolSummary(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const values = input as Record<string, unknown>;
  const key = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description'].find((candidate) => typeof values[candidate] === 'string' && (values[candidate] as string).trim());
  if (!key) return undefined;
  const value = (values[key] as string).trim().replace(/\s+/g, ' ');
  return `${name === 'Bash' ? '' : `${name} `}${value.length > 300 ? `${value.slice(0, 297)}…` : value}`.trim();
}

function requireSupportedVersion(version: unknown): void {
  const match = typeof version === 'string' ? version.match(/^(\d+)\.(\d+)\.(\d+)/) : null;
  const [major, minor, patch] = match ? match.slice(1).map(Number) : [0, 0, 0];
  if (!match || major < 2 || (major === 2 && (minor < 1 || (minor === 1 && patch < 259)))) {
    throw new ClaudeCodeError(`Claude Code 版本 ${match?.[0] ?? '未知'} 不支持此执行协议；需要 2.1.259 或更高版本。`);
  }
}
