import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { projectTaskCaptureFailureMessage, toolCallRejection, type ToolCallAdmission } from './agent-executions.service';
import { ClaudeCodeError } from './claude-code.service';
import { CodexAppServerError } from './codex-app-server.service';

const admission = (overrides: Partial<ToolCallAdmission> = {}): ToolCallAdmission => ({
  index: 0,
  total: 1,
  toolName: 'skill_script',
  chatOnly: true,
  hasBuiltinTool: false,
  hasSkill: true,
  hasScript: true,
  hasMcpTool: false,
  clarificationPass: false,
  projectTaskWithOtherTools: false,
  pendingQuestion: false,
  ...overrides,
});

describe('toolCallRejection', () => {
  it('admits a batch of independent platform calls instead of failing the turn', () => {
    expect(toolCallRejection(admission({ index: 0, total: 8 }))).toBeNull();
    expect(toolCallRejection(admission({ index: 7, total: 8 }))).toBeNull();
  });

  it('defers calls beyond the per-step ceiling with an actionable reason', () => {
    expect(toolCallRejection(admission({ index: 16, total: 20 }))).toContain('Reissue this call in a later step');
    expect(toolCallRejection(admission({ index: 15, total: 20 }))).toBeNull();
  });

  it('rejects only the offending call, not the whole response', () => {
    expect(toolCallRejection(admission({ toolName: 'bash', chatOnly: true }))).toBe('Chat may only dispatch tasks and use protected platform operations.');
    expect(toolCallRejection(admission({ hasSkill: false }))).toBe('The model requested a Skill script that is not assigned or executable.');
    expect(toolCallRejection(admission({ toolName: 'mcp_x', chatOnly: false, total: 2, hasMcpTool: false }))).toBe('The model requested an MCP tool that is not assigned or available.');
    expect(toolCallRejection(admission({ toolName: 'ask_user', hasBuiltinTool: true, total: 2 }))).toBe('The clarification tool must be requested in its own model step.');
    expect(toolCallRejection(admission({ toolName: 'ask_user', hasBuiltinTool: true, total: 1 }))).toBeNull();
  });

  it('still allows one project task accompanied by a plan update', () => {
    expect(toolCallRejection(admission({ toolName: 'project_task', hasBuiltinTool: true, projectTaskWithOtherTools: false }))).toBeNull();
    expect(toolCallRejection(admission({ toolName: 'project_task', hasBuiltinTool: true, projectTaskWithOtherTools: true }))).toContain('只能派发一个 project_task');
  });
});

describe('projectTaskCaptureFailureMessage', () => {
  it('surfaces a NotFoundException raised while resolving the executor model against the Gateway', () => {
    const error = new NotFoundException('Model provider GLM was not found.');
    expect(projectTaskCaptureFailureMessage(error)).toBe('Model provider GLM was not found.');
  });

  it('surfaces a ServiceUnavailableException raised when the Gateway is unreachable', () => {
    const error = new ServiceUnavailableException('Portkey Gateway is unavailable.');
    expect(projectTaskCaptureFailureMessage(error)).toBe('Portkey Gateway is unavailable.');
  });

  it('surfaces a BadRequestException from an invalid project task request', () => {
    const error = new BadRequestException('A project task requires an absolute workspace directory.');
    expect(projectTaskCaptureFailureMessage(error)).toBe('A project task requires an absolute workspace directory.');
  });

  it('surfaces a ConflictException from a missing capability snapshot', () => {
    const error = new ConflictException('This Chat turn has no captured capabilities; start a new turn.');
    expect(projectTaskCaptureFailureMessage(error)).toBe('This Chat turn has no captured capabilities; start a new turn.');
  });

  it('surfaces a CodexAppServerError from an unsupported Codex version', () => {
    const error = new CodexAppServerError('Codex 版本 0.1.0 不支持此执行协议；需要 0.157.1 或更高版本。');
    expect(projectTaskCaptureFailureMessage(error)).toBe('Codex 版本 0.1.0 不支持此执行协议；需要 0.157.1 或更高版本。');
  });

  it('surfaces a ClaudeCodeError from an unsupported Claude Code version', () => {
    const error = new ClaudeCodeError('Claude Code 版本 2.0.0 不支持此执行协议；需要 2.1.259 或更高版本。');
    expect(projectTaskCaptureFailureMessage(error)).toBe('Claude Code 版本 2.0.0 不支持此执行协议；需要 2.1.259 或更高版本。');
  });

  it('falls back to the generic message for an unrecognized error type', () => {
    expect(projectTaskCaptureFailureMessage(new Error('ECONNRESET'))).toBe('无法启动项目任务，请检查项目目录、执行器插件可用性和 Gateway 模型。');
    expect(projectTaskCaptureFailureMessage('not an Error instance')).toBe('无法启动项目任务，请检查项目目录、执行器插件可用性和 Gateway 模型。');
  });
});
