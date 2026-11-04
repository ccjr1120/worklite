import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query, type CanUseTool, type McpServerConfig, type Options, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StoredProjectExecutorLaunch } from '@worklite/db';
import { gatewayAttributionHeaders } from '@worklite/model-gateway';
import { McpClientService } from '../mcp-servers/mcp-client.service';
import { requireGatewayUrl, isGatewayPublicModel, localGatewayBaseUrl, type AgentRuntimeAdapter, type PreparedProjectExecution, type ProjectExecutorActivity, type ProjectExecutorRequest } from './project-executor.types';

type ClaudeLaunch = Extract<StoredProjectExecutorLaunch, { executor: 'claude' }>;

export class ClaudeCodeError extends Error {}

// Claude Code runs through the official `@anthropic-ai/claude-agent-sdk`'s streaming-input query():
// it owns process startup, the control protocol, and its own bundled Claude Code binary. WorkLite
// maps SDK messages to task activities, answers AskUserQuestion by handing the question to the
// owning task state machine and keeping the SDK session alive while it is answered, and converts
// SDK failures, error results and abnormal termination into readable task failures.
@Injectable()
export class ClaudeCodeService implements AgentRuntimeAdapter {
  readonly capabilities = { resume: true, steer: false, liveQuestions: true, approvals: true } as const;
  constructor(private readonly mcp: McpClientService) {}

  async captureLaunch(model: string | null): Promise<ClaudeLaunch> {
    // A declared Gateway model is served by the WorkLite Gateway itself.
    if (isGatewayPublicModel(model)) {
      return { executor: 'claude', commandArguments: [], baseUrl: localGatewayBaseUrl(), model };
    }
    // Any other model uses WorkLite's own Claude configuration, never the operator's ~/.claude.
    let settingsEnv: Record<string, unknown> = {};
    try {
      const settings = JSON.parse(await readFile(join(claudeConfigDirectory(), 'settings.json'), 'utf8')) as { env?: Record<string, unknown> };
      settingsEnv = settings.env ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BadRequestException(`无法读取 ${join(claudeConfigDirectory(), 'settings.json')}。`);
    }
    const baseUrl = requireGatewayUrl(settingsEnv.ANTHROPIC_BASE_URL ?? localGatewayBaseUrl(), 'WorkLite Claude 配置的 ANTHROPIC_BASE_URL ');
    return { executor: 'claude', commandArguments: [], baseUrl, model };
  }

  async execute(request: ProjectExecutorRequest, prepared: PreparedProjectExecution): Promise<string> {
    request.signal.throwIfAborted();
    const launch = request.launch as ClaudeLaunch;
    const model = request.model ?? launch.model;
    const mcpServers = await resolveClaudeMcpServers(prepared, (server) => this.mcp.discover(
      { endpoint: server.endpoint, ...(server.authToken ? { authToken: server.authToken } : {}) },
      request.signal,
    ));
    const session = new ClaudeCodeSession(request);
    const sdkQuery = query({
      prompt: session.inputStream(),
      options: {
        cwd: request.projectDirectory,
        // The default system prompt is minimal; the claude_code preset keeps Claude Code Agent's
        // ordinary working style and WorkLite's own instructions are appended to it.
        systemPrompt: { type: 'preset', preset: 'claude_code', append: prepared.systemPrompt },
        ...(model ? { model } : {}),
        includePartialMessages: true,
        persistSession: Boolean(request.runtimeSession) || request.owner === 'coder',
        ...(request.runtimeSession?.resumeId ? { resume: request.runtimeSession.resumeId } : {}),
        // 'user' resolves inside WorkLite's own CLAUDE_CONFIG_DIR (see `env`), so the operator's
        // ~/.claude settings, plugins and login never apply. 'project' is required for CLAUDE.md
        // discovery in the task's working directory (confirmed live: omitting it silently drops
        // project instructions); 'local' is the project's .claude/settings.local.json. The
        // flag-settings layer below still wins over all three for Gateway env.
        settingSources: ['user', 'project', 'local'],
        settings: { env: await this.gatewaySettingsEnv(model, launch, request) },
        env: await isolatedEnvironment(model, launch),
        permissionMode: request.approvalPolicy === 'ask' ? 'default' : 'bypassPermissions',
        allowDangerouslySkipPermissions: request.approvalPolicy !== 'ask',
        canUseTool: session.canUseTool,
        ...(mcpServers.config ? { mcpServers: mcpServers.config } : {}),
        ...(mcpServers.disallowedTools.length ? { disallowedTools: mcpServers.disallowedTools } : {}),
        ...(prepared.pluginDirectory ? { plugins: [{ type: 'local', path: prepared.pluginDirectory }] } : {}),
      } satisfies Options,
    });
    session.attach(sdkQuery);
    const cancel = () => session.cancel(request.signal.reason ?? new Error('The Claude Code task was cancelled.'));
    request.signal.addEventListener('abort', cancel, { once: true });
    if (request.signal.aborted) { cancel(); request.signal.throwIfAborted(); }
    try {
      await session.activity('claude.started');
      session.start();
      const output = await session.result();
      request.signal.throwIfAborted();
      await session.activity('claude.completed');
      return output;
    } finally {
      request.signal.removeEventListener('abort', cancel);
      session.close();
    }
  }

  // Gateway models route through the per-task flag-settings env layer, which merges by key over
  // the WorkLite Claude settings.json env and carries no other process environment.
  private async gatewaySettingsEnv(model: string | null, launch: ClaudeLaunch, request: ProjectExecutorRequest): Promise<Record<string, string>> {
    const attribution = { ANTHROPIC_CUSTOM_HEADERS: correlationHeaders(request) };
    if (!isGatewayPublicModel(model)) return attribution;
    return { ANTHROPIC_BASE_URL: localGatewayBaseUrl(), ANTHROPIC_AUTH_TOKEN: 'worklite', ...attribution };
  }

}

// WorkLite's own Claude Code configuration directory, kept apart from the operator's ~/.claude so
// neither side's settings, plugins, MCP servers or login affect the other.
export function claudeConfigDirectory(): string {
  return join(homedir(), '.worklite', 'claude');
}

// The Claude Code process environment: the API's own environment without any inherited
// ANTHROPIC_* or CLAUDE_* variable (an API started from a Claude Code shell would otherwise pass
// that session's base URL, token and session ids through), pointed at WorkLite's config directory.
// A non-Gateway model gets the captured Gateway base URL as a process-env default, which the
// WorkLite settings.json env overrides when it sets its own.
async function isolatedEnvironment(model: string | null, launch: ClaudeLaunch): Promise<Record<string, string>> {
  const directory = claudeConfigDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const inherited = Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !/^(ANTHROPIC_|CLAUDE_)/.test(entry[0]));
  return {
    ...Object.fromEntries(inherited),
    CLAUDE_CONFIG_DIR: directory,
    ...(isGatewayPublicModel(model) ? {} : { ANTHROPIC_BASE_URL: launch.baseUrl, ANTHROPIC_AUTH_TOKEN: 'worklite' }),
  };
}

const mcpLogger = new Logger('ClaudeCodeMcp');

/**
 * Resolves selected MCP servers into the SDK's own `mcpServers` option, never a file. Claude Code
 * has no per-server tool allowlist, so tools outside the captured allowlist are disallowed by name
 * through the SDK's `disallowedTools`. A server whose discovery fails is skipped rather than
 * injected unvetted, but the failure is logged: silently dropping the WorkLite Coder memory server
 * would hide its tools.
 */
export async function resolveClaudeMcpServers(
  prepared: PreparedProjectExecution,
  discover: (server: { key: string; endpoint: string; authToken?: string }) => Promise<Array<{ name: string }>>,
): Promise<{ config: Record<string, McpServerConfig> | undefined; disallowedTools: string[] }> {
  const config: Record<string, McpServerConfig> = {};
  const disallowedTools: string[] = [];
  for (const server of prepared.mcpServers) {
    let tools: Array<{ name: string }>;
    try {
      tools = await discover(server);
    } catch (error) {
      mcpLogger.warn(`MCP server ${server.key} could not be discovered and was not injected into Claude Code: ${error instanceof Error ? error.message : 'unknown error'}`);
      continue;
    }
    config[server.key] = { type: 'http', url: server.endpoint, ...(server.authToken ? { headers: { Authorization: `Bearer ${server.authToken}` } } : {}) };
    disallowedTools.push(...tools.filter((tool) => !server.allowedTools.includes(tool.name)).map((tool) => `mcp__${server.key}__${tool.name}`));
  }
  return { config: Object.keys(config).length ? config : undefined, disallowedTools };
}

/**
 * Claude Code sends these with every request it makes to its configured Anthropic base
 * URL, which is the WorkLite Gateway. Without them the executor's traffic reaches the
 * Gateway with no attribution and lands in the 'unattributed' group, so the full
 * correlation is rendered here rather than only the executor fields.
 */
function correlationHeaders(request: ProjectExecutorRequest): string {
  const correlation = request.correlation
    ?? { surface: request.owner === 'coder' ? 'coder_project_task' as const : 'chat_project_task' as const, executor: 'claude' as const };
  return Object.entries(gatewayAttributionHeaders(correlation)).map(([name, value]) => `${name}: ${value}`).join('\n');
}

/**
 * One SDK session's lifecycle: streamed user input, message consumption, the live
 * AskUserQuestion wait, cancellation, and the final task text or failure. `onFailure`
 * (passed through the request) is never used directly here; failures surface through
 * `result()` rejecting, which the caller awaits before closing the session.
 */
class ClaudeCodeSession {
  private sdkQuery?: Query;
  private text = '';
  // Set once a Coder task attempt (no onQuestion, no live session) has denied AskUserQuestion:
  // the turn ends right after with this `waiting_for_input` JSON as its result, the same contract
  // Codex's own question path produces, instead of whatever text the model goes on to write.
  private questionOutput?: string;
  // Questions this run has already asked, keyed by the SDK's control requestId, so a cancel
  // reaching a still-pending question can resolve it exactly once.
  private readonly pendingQuestions = new Map<string, { resolve: (result: PermissionResult) => void }>();
  private readonly toolNames = new Map<string, string>();
  private eventQueue = Promise.resolve();
  private failed?: unknown;
  private readonly finished: Promise<string>;
  private finish!: (text: string) => void;
  private reject!: (error: unknown) => void;
  private closing = false;
  // Resolves once the one streamed input message has been yielded, so close() can end the
  // input generator without racing its own first (and only) send.
  private inputSent?: () => void;

  constructor(private readonly request: ProjectExecutorRequest) {
    this.finished = new Promise((resolve, reject) => { this.finish = resolve; this.reject = reject; });
    void this.finished.catch(() => undefined);
  }

  attach(sdkQuery: Query): void { this.sdkQuery = sdkQuery; }

  // Streamed so the SDK keeps the control channel (interrupt, canUseTool) available; the task
  // has exactly one user turn, so the generator yields once and then waits to be torn down by
  // close() rather than completing on its own (an ended generator in non-persisted mode would
  // let the CLI exit before the result and any trailing control traffic are read).
  async *inputStream(): AsyncGenerator<SDKUserMessage> {
    const message: SDKUserMessage = { type: 'user', message: { role: 'user', content: this.request.input }, parent_tool_use_id: null };
    yield message;
    this.inputSent?.();
    await new Promise<void>((resolve) => { this.inputSent = resolve; });
  }

  start(): void {
    void this.consume();
  }

  private async consume(): Promise<void> {
    try {
      if (!this.sdkQuery) throw new Error('Claude Code session is not attached.');
      for await (const message of this.sdkQuery) {
        if (this.failed) break;
        await this.receive(message);
      }
      if (!this.failed && !this.closing) this.fail(new Error('Claude Code stopped before completing its task.'));
    } catch (error) {
      if (!this.closing) this.fail(error);
    }
  }

  readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    if (this.failed) return { behavior: 'deny', message: 'The Claude Code session has ended.' };
    if (toolName !== 'AskUserQuestion') {
      if (this.request.approvalPolicy === 'ask') {
        const allowed = await this.request.onApproval?.(`Claude requests permission to use ${toolName}.\n${JSON.stringify(input, null, 2)}`);
        this.request.signal.throwIfAborted();
        return allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user declined this tool request.' };
      }
      return { behavior: 'allow', updatedInput: input };
    }
    const questions = Array.isArray((input as { questions?: unknown }).questions)
      ? (input as { questions: Array<{ question?: unknown }> }).questions
      : [];
    const questionText = questions.map((item) => item.question).filter((item): item is string => typeof item === 'string' && !!item.trim()).join('\n');
    if (!questionText) return { behavior: 'deny', message: 'AskUserQuestion was called without question text.' };
    this.queueActivity('claude.question_asked', { itemType: 'AskUserQuestion', summary: questionText });
    // No live-session channel (a Coder task attempt, whose LangGraph checkpoint boundary cannot
    // hold a session open across an answer): deny the call so the turn ends now, and replace the
    // eventual result text with the same waiting_for_input JSON Codex's own question path
    // produces. The caller re-runs the whole task with the answer appended once it has one.
    if (!this.request.onQuestion) {
      this.questionOutput = JSON.stringify({ status: 'waiting_for_input', pendingInput: { question: questionText } });
      return { behavior: 'deny', message: 'WorkLite forwarded this question to the user. Stop and wait for the answer.' };
    }
    return new Promise<PermissionResult>((resolve) => {
      this.pendingQuestions.set(options.requestId, { resolve });
      const settle = (result: PermissionResult) => {
        if (!this.pendingQuestions.delete(options.requestId)) return;
        resolve(result);
      };
      // Responds to cancellation even while the answer is still pending: the task's own abort
      // signal (not the SDK-supplied one, which the SDK does not abort on interrupt or close)
      // ends the wait so a cancelled task never leaves a question parked forever.
      const onAbort = () => settle({ behavior: 'deny', message: 'The task was cancelled while waiting for the answer.' });
      this.request.signal.addEventListener('abort', onAbort, { once: true });
      void this.waitForAnswer(questionText, input, { settle, onAbort });
    });
  };

  // Hands the question to the task's own state machine (Chat's ChatProjectTasksService), which
  // persists it as the pending question and moves the task to waiting_for_input while this stays
  // parked; once the user answers, the SDK's AskUserQuestion input format answers every asked
  // question with that text so the very same session continues instead of a new one starting.
  // The SDK reads the answer from `updatedInput.answers`, keyed by each question's text, next to
  // the original `questions` array (verified live against SDK 0.3.316).
  private async waitForAnswer(
    questionText: string,
    input: Record<string, unknown>,
    handle: { settle: (result: PermissionResult) => void; onAbort: () => void },
  ): Promise<void> {
    try {
      const answer = await this.request.onQuestion!(questionText);
      this.request.signal.removeEventListener('abort', handle.onAbort);
      if (answer === undefined) { handle.settle({ behavior: 'deny', message: 'The task was cancelled while waiting for the answer.' }); return; }
      const asked = Array.isArray(input.questions) ? input.questions as Array<{ question?: unknown }> : [];
      const answers = Object.fromEntries(asked.flatMap((item) => typeof item.question === 'string' ? [[item.question, answer]] : []));
      handle.settle({ behavior: 'allow', updatedInput: { ...input, answers } });
    } catch (error) {
      this.request.signal.removeEventListener('abort', handle.onAbort);
      handle.settle({ behavior: 'deny', message: 'Answering the question failed.' });
      this.fail(error);
    }
  }

  cancel(reason: unknown): void {
    if (this.failed) return;
    void this.sdkQuery?.interrupt().catch(() => undefined);
    for (const pending of [...this.pendingQuestions.values()]) {
      pending.resolve({ behavior: 'deny', message: 'The task was cancelled.' });
    }
    this.pendingQuestions.clear();
    this.fail(reason);
  }

  close(): void {
    this.closing = true;
    this.inputSent?.();
    this.sdkQuery?.close();
    this.fail(new Error('The Claude Code session is closed.'));
  }

  fail(error: unknown): void {
    if (this.failed) return;
    this.failed = error;
    this.reject(error);
  }

  async result(): Promise<string> {
    let text: string;
    try { text = await this.finished; }
    finally { await this.eventQueue; }
    if (!text.trim()) throw new Error('Claude Code returned an empty task result.');
    return text.trim();
  }

  activity(phase: string, detail: Partial<ProjectExecutorActivity> = {}): Promise<void> {
    return Promise.resolve(this.request.onEvent?.({ phase, ...detail }));
  }

  private queueActivity(phase: string, detail: Partial<ProjectExecutorActivity>): void {
    this.eventQueue = this.eventQueue.then(() => this.activity(phase, detail)).catch((error) => this.fail(error));
  }

  private async receive(message: SDKMessage): Promise<void> {
    if (message.type === 'system' && message.subtype === 'init') {
      await this.request.runtimeSession?.onSession(message.session_id);
      this.queueActivity('claude.session_started', { sessionId: message.session_id });
      return;
    }
    const topLevel = 'parent_tool_use_id' in message ? message.parent_tool_use_id == null : true;
    if (message.type === 'stream_event' && topLevel) {
      const event = message.event;
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        const delta = event.delta.text;
        this.eventQueue = this.eventQueue.then(() => this.request.onTextDelta?.(delta)).then(() => undefined).catch((error) => this.fail(error));
      }
      return;
    }
    if (message.type === 'assistant' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === 'text' && topLevel && typeof block.text === 'string') {
          this.text = block.text;
          this.queueActivity('claude.agent_message', { itemType: 'agent_message', text: block.text });
        }
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          this.toolNames.set(block.id, String(block.name));
          const summary = toolSummary(String(block.name), block.input);
          this.queueActivity('claude.tool_started', { itemId: block.id, itemType: String(block.name), ...(summary ? { summary } : {}) });
        }
      }
      return;
    }
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'tool_result') continue;
        const result = block as { tool_use_id?: unknown; is_error?: unknown };
        if (typeof result.tool_use_id !== 'string') continue;
        const itemType = this.toolNames.get(result.tool_use_id);
        this.queueActivity('claude.tool_completed', { itemId: result.tool_use_id, ...(itemType ? { itemType } : {}), ...(result.is_error ? { summary: 'error' } : {}) });
      }
      return;
    }
    if (message.type === 'result') {
      if (typeof message.usage?.input_tokens === 'number' && typeof message.usage?.output_tokens === 'number') {
        const inputTokens = message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0);
        const outputTokens = message.usage.output_tokens;
        this.queueActivity('claude.usage', { usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } });
      }
      if (this.questionOutput) this.finish(this.questionOutput);
      else if (message.subtype === 'success' && !message.is_error) this.finish(message.result.trim() ? message.result : this.text);
      else {
        const errors = 'errors' in message && Array.isArray(message.errors) && message.errors.length ? `: ${message.errors.join('; ')}`
          : message.subtype === 'success' && typeof message.result === 'string' && message.result ? `: ${message.result}`
            : '';
        this.fail(new ClaudeCodeError(`The Claude Code turn failed (${message.subtype})${errors}.`));
      }
    }
  }
}

function toolSummary(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const values = input as Record<string, unknown>;
  const key = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description'].find((candidate) => typeof values[candidate] === 'string' && (values[candidate] as string).trim());
  if (!key) return undefined;
  const value = (values[key] as string).trim().replace(/\s+/g, ' ');
  return `${name === 'Bash' ? '' : `${name} `}${value.length > 300 ? `${value.slice(0, 297)}…` : value}`.trim();
}
