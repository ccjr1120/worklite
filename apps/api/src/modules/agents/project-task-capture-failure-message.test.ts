import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { projectTaskCaptureFailureMessage } from './agent-executions.service';
import { ClaudeCodeError } from './claude-code.service';
import { CodexAppServerError } from './codex-app-server.service';

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

  it('surfaces a CodexAppServerError from the executor launch', () => {
    const error = new CodexAppServerError('~/.codex-cli 的 Codex Provider 必须使用 Responses 协议。');
    expect(projectTaskCaptureFailureMessage(error)).toBe('~/.codex-cli 的 Codex Provider 必须使用 Responses 协议。');
  });

  it('surfaces a ClaudeCodeError from the executor launch', () => {
    const error = new ClaudeCodeError('无法读取 ~/.claude/settings.json。');
    expect(projectTaskCaptureFailureMessage(error)).toBe('无法读取 ~/.claude/settings.json。');
  });

  it('falls back to the generic message for an unrecognized error type', () => {
    expect(projectTaskCaptureFailureMessage(new Error('ECONNRESET'))).toBe('无法启动项目任务，请检查项目目录、执行器插件可用性和 Gateway 模型。');
    expect(projectTaskCaptureFailureMessage('not an Error instance')).toBe('无法启动项目任务，请检查项目目录、执行器插件可用性和 Gateway 模型。');
  });
});
