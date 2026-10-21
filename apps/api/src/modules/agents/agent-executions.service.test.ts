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
