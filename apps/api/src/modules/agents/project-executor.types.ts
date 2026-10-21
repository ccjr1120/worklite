import { BadRequestException } from '@nestjs/common';
import type { StoredProjectExecutor, StoredProjectExecutorLaunch } from '@worklite/db';
import type { GatewayCorrelation } from '@worklite/model-gateway';

export type ProjectExecutorActivity = {
  phase: string;
  commandExecutionId: string;
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
  owner: 'chat' | 'team';
  workspaceId: string;
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
  signal: AbortSignal;
  correlation?: GatewayCorrelation;
  // Caller-owned mid-run steering channel; the executor sets `deliver` once a steerable turn exists.
  steerPort?: ProjectExecutorSteerPort;
  onTextDelta?: (delta: string) => void | Promise<void>;
  onEvent?: (activity: ProjectExecutorActivity) => void | Promise<void>;
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

// Gateway Provider protocols Claude Code can speak; Provider protocols are never switched to fit an executor.
// Codex launches natively through the operator's own configured shell command and is not required to speak a
// Gateway protocol or use a Gateway-known model, so it has no entry here.
export const PROJECT_EXECUTOR_PROTOCOLS: Partial<Record<StoredProjectExecutor, readonly string[]>> = {
  claude: ['anthropic/messages'],
};

// Codex's configured command word is interpolated unquoted into an inline zsh script so shell alias
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
