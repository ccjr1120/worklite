import { BadRequestException } from '@nestjs/common';
import type { StoredProjectExecutor, StoredProjectExecutorLaunch } from '@worklite/db';
import type { GatewayCorrelation } from '@worklite/model-gateway';

export type ProjectExecutorActivity = {
  phase: string;
  usage?: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  // Codex activities carry the backing CommandExecution id. Claude Agent SDK activities have no
  // process-level command record of their own and carry `sessionId` instead.
  commandExecutionId?: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  itemType?: string;
  summary?: string;
  text?: string;
};

export type ProjectExecutorSkill = {
  id: string;
  name: string;
  files: ReadonlyArray<{ path: string; content: string }>;
};

export type ProjectExecutorMcpServer = {
  id: string;
  name: string;
  endpoint: string;
  authToken?: string;
  allowedTools: string[];
};

// A live mid-turn delivery channel an executor may populate once it has a steerable turn (Codex
// `turn/steer`). `deliver` resolves true only when the executor's own live turn accepted the text;
// false (including when the executor never populates `deliver` at all, as Claude Code never does)
// tells the caller to queue the instruction for the task's next run instead.
export type ProjectExecutorSteerPort = { deliver?: (text: string) => Promise<boolean> };

export type ProjectExecutorRequest = {
  owner: 'chat' | 'coder' | 'agent';
  workspaceId: string;
  // Present only for durable WorkLite Agent sessions. Resource paths remain stable across turns.
  runtimeSession?: { resumeId?: string; onSession: (id: string) => Promise<void> };
  resourceDirectory?: string;
  launch: StoredProjectExecutorLaunch;
  // Public Gateway model id; null keeps the executor's own configured default.
  model: string | null;
  systemPrompt: string;
  input: string;
  projectDirectory: string;
  skills: readonly ProjectExecutorSkill[];
  mcpServers: readonly ProjectExecutorMcpServer[];
  // Read-only files the executor may consult, materialized outside the project.
  references?: ReadonlyArray<{ path: string; content: string }>;
  // User-supplied images for this task (the Web composer's pasted images). prepare() materializes
  // them next to the references and names their absolute paths in the prompt; both executors read
  // an image from disk with their own image tool, so no executor-specific input format is needed.
  images?: ReadonlyArray<{ fileName: string; description?: string; body: Buffer }>;
  signal: AbortSignal;
  correlation?: GatewayCorrelation;
  // Caller-owned mid-run steering channel; the executor sets `deliver` once a steerable turn exists.
  steerPort?: ProjectExecutorSteerPort;
  onTextDelta?: (delta: string) => void | Promise<void>;
  onEvent?: (activity: ProjectExecutorActivity) => void | Promise<void>;
  /**
   * Live-session question answering for Claude AskUserQuestion and Codex user-input requests. When supplied (Chat
   * project tasks), a question keeps the SDK session alive: the executor calls this with the
   * asked question text and awaits the task owner's answer (through its own state machine going
   * to waiting_for_input), then feeds that answer straight back into the same session. Resolving
   * with `undefined` means the task was cancelled while waiting. Chat project tasks and Coder
   * task attempts both supply it. When omitted, the executor instead ends the turn immediately with the same
   * `{"status":"waiting_for_input","pendingInput":{"question":...}}` text result,
   * and a new attempt re-runs the whole task with the answer appended to its input.
   */
  onQuestion?: (question: string) => Promise<string | undefined>;
  approvalPolicy?: 'auto' | 'ask';
  onApproval?: (description: string) => Promise<boolean>;
};

export type PreparedProjectExecution = {
  directory: string;
  systemPrompt: string;
  // Directory whose children are skill folders, or undefined when no Skill was selected.
  skillRoot?: string;
  // Claude Code plugin directory wrapping skillRoot.
  pluginDirectory?: string;
  mcpServers: Array<ProjectExecutorMcpServer & { key: string }>;
};

// Gateway Provider protocols each executor can speak; Provider protocols are never switched to fit an executor.
// With no model, Codex starts using the `codex` command and its local configuration. A selected Gateway public
// model keeps the configured command word and is served through the Gateway's Responses endpoint.
export const PROJECT_EXECUTOR_PROTOCOLS: Partial<Record<StoredProjectExecutor, readonly string[]>> = {
  claude: ['anthropic/messages'],
  codex: ['openai/responses', 'codex/responses'],
};

// A Gateway public model id is `<providerName>/<modelId>` (Provider names cannot contain "/"). Any other model
// value is treated as the executor's own native model designation and runs through local configuration.
export function isGatewayPublicModel(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false;
  const separator = model.indexOf('/');
  return separator > 0 && separator < model.length - 1;
}

// Chat and executors run on the same host as this API; the Gateway sidecar owns this port.
export function localGatewayBaseUrl(): string {
  return `http://127.0.0.1:${Number(process.env.PORTKEY_GATEWAY_PORT ?? 23392)}`;
}

// Codex's Gateway-model command word is interpolated unquoted into an inline zsh script so shell alias
// expansion (e.g. cxo, cx) applies the same way it would in an interactive terminal; this restricts it to a
// bare alias/executable name or path so no shell metacharacter can be injected through plugin configuration.
const SAFE_COMMAND_WORD = /^[\w./-]+$/;

export function requireSafeCommandWord(word: string | undefined): string {
  const trimmed = word?.trim();
  if (!trimmed) throw new BadRequestException('A Codex command is required; configure the Codex plugin command.');
  if (!SAFE_COMMAND_WORD.test(trimmed)) throw new BadRequestException('The Codex command must be a single alias, executable name or path without shell syntax.');
  return trimmed;
}

const GATEWAY_PORTS = [23390, 23391, 23392];

export function requireGatewayUrl(value: unknown, label: string): string {
  let url: URL;
  try { url = new URL(String(value)); }
  catch { throw new BadRequestException(`${label}未配置有效的 Gateway 地址。`); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !GATEWAY_PORTS.includes(Number(url.port))) {
    throw new BadRequestException(`${label}不属于当前 WorkLite Gateway。`);
  }
  return url.toString();
}

export type AgentRuntimeCapabilities = {
  resume: boolean;
  steer: boolean;
  liveQuestions: boolean;
  approvals: boolean;
};

export interface AgentRuntimeAdapter {
  readonly capabilities: AgentRuntimeCapabilities;
  execute(request: ProjectExecutorRequest, prepared: PreparedProjectExecution): Promise<string>;
}
