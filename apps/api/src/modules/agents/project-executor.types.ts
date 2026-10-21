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

// Gateway Provider protocols each executor can speak; Provider protocols are never switched to fit an executor.
export const PROJECT_EXECUTOR_PROTOCOLS: Record<StoredProjectExecutor, readonly string[]> = {
  codex: ['openai/responses', 'codex/responses'],
  claude: ['anthropic/messages'],
};

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
