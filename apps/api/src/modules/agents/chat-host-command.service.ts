import { Injectable } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const HOST_COMMAND_SHELL = '/bin/zsh';
const HOST_COMMAND_SHELL_ARGS = ['-lc'] as const;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 900_000;
const DEFAULT_OUTPUT_CHARS = 20_000;
const MAX_OUTPUT_CHARS = 100_000;
const DEFAULT_STREAM_CHARS = 40_000;
const MAX_STREAM_CHARS = 200_000;
const MAX_COMMAND_CHARS = 20_000;
const MAX_CWD_CHARS = 4_096;
const MIN_TIMEOUT_MS = 100;
const FIELD_TRUNCATION_MARKER = '[truncated]';
const HOST_COMMAND_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE'] as const;
const HOST_COMMAND_INPUT_KEYS = new Set(['command', 'cwd', 'timeoutMs']);

export type ChatHostCommandConfig = {
  shell: string;
  defaultCwd: string;
  timeoutMs: number;
  maxTimeoutMs: number;
  outputChars: number;
  streamChars: number;
};

export type ChatHostCommandInput = {
  command: string;
  cwd: string;
  timeoutMs: number;
};

export type ChatHostCommandResult = {
  status: 'completed' | 'failed';
  command: string;
  cwd: string;
  shell: string;
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  output: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  rejected: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputTruncated: boolean;
};

class HostCommandRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostCommandRejected';
  }
}

// The child never inherits the API environment. Only the host details a normal CLI needs are
// copied; WorkLite credentials, tokens, arbitrary NODE_OPTIONS and unrelated service settings stay out.
export function buildHostCommandEnvironment(source: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of HOST_COMMAND_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return {
    ...env,
    SHELL: HOST_COMMAND_SHELL,
    PWD: cwd,
    CI: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    npm_config_yes: 'true',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
}

export function readChatHostCommandConfig(env: NodeJS.ProcessEnv = process.env, home = homedir()): ChatHostCommandConfig {
  const defaultCwd = resolve(env.WORKLITE_CHAT_HOST_COMMAND_DEFAULT_CWD?.trim() || home);
  const maxTimeoutMs = boundedInteger(env.WORKLITE_CHAT_HOST_COMMAND_MAX_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const timeoutMs = Math.min(maxTimeoutMs, boundedInteger(env.WORKLITE_CHAT_HOST_COMMAND_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, maxTimeoutMs));
  return {
    shell: HOST_COMMAND_SHELL,
    defaultCwd,
    timeoutMs,
    maxTimeoutMs,
    outputChars: boundedInteger(env.WORKLITE_CHAT_HOST_COMMAND_OUTPUT_CHARS, DEFAULT_OUTPUT_CHARS, 200, MAX_OUTPUT_CHARS),
    streamChars: boundedInteger(env.WORKLITE_CHAT_HOST_COMMAND_STREAM_CHARS, DEFAULT_STREAM_CHARS, 200, MAX_STREAM_CHARS),
  };
}

export function parseChatHostCommandInput(input: unknown, config: ChatHostCommandConfig): ChatHostCommandInput {
  const record = asRecord(input);
  if (!record) throw new HostCommandRejected('run_host_command expects one JSON object.');
  const unexpected = Object.keys(record).find((key) => !HOST_COMMAND_INPUT_KEYS.has(key));
  if (unexpected) throw new HostCommandRejected(`Unknown input field: ${unexpected}.`);
  const command = record.command;
  if (typeof command !== 'string' || !command.trim()) throw new HostCommandRejected('A shell command is required.');
  if (command.length > MAX_COMMAND_CHARS) throw new HostCommandRejected(`The command must be at most ${MAX_COMMAND_CHARS} characters.`);
  if (command.includes('\0')) throw new HostCommandRejected('The command must not contain NUL characters.');

  let cwd = config.defaultCwd;
  if (record.cwd !== undefined) {
    if (typeof record.cwd !== 'string' || !record.cwd.trim()) throw new HostCommandRejected('cwd must be a non-empty absolute directory path.');
    cwd = record.cwd.trim();
  }
  if (!isAbsolute(cwd)) throw new HostCommandRejected('cwd must be an absolute path.');
  if (cwd.length > MAX_CWD_CHARS) throw new HostCommandRejected(`cwd must be at most ${MAX_CWD_CHARS} characters.`);
  try {
    const canonical = realpathSync(cwd);
    if (!statSync(canonical).isDirectory()) throw new HostCommandRejected('cwd must be an existing directory.');
    accessSync(canonical, constants.X_OK);
    cwd = canonical;
  } catch (error) {
    if (error instanceof HostCommandRejected) throw error;
    throw new HostCommandRejected('cwd must be an existing, accessible directory.');
  }

  let timeoutMs = config.timeoutMs;
  if (record.timeoutMs !== undefined) {
    if (typeof record.timeoutMs !== 'number' || !Number.isInteger(record.timeoutMs) || record.timeoutMs < MIN_TIMEOUT_MS) {
      throw new HostCommandRejected(`timeoutMs must be an integer of at least ${MIN_TIMEOUT_MS}.`);
    }
    if (record.timeoutMs > config.maxTimeoutMs) throw new HostCommandRejected(`timeoutMs must be at most ${config.maxTimeoutMs}.`);
    timeoutMs = record.timeoutMs;
  }
  return { command, cwd, timeoutMs };
}

export function boundHostCommandOutput(output: string, limit: number): string {
  if (limit <= 0) return '';
  if (output.length <= limit) return output;
  const marker = '[Output truncated; showing the trailing text.]\n';
  if (limit <= marker.length) return output.slice(-limit);
  return `${marker}${output.slice(-Math.max(0, limit - marker.length))}`;
}

export function formatChatHostCommandOutput(input: {
  command: string;
  cwd: string;
  shell: string;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  timeoutMs: number;
}, limit?: number): string {
  const metadata = [
    `command: ${input.command}`,
    `cwd: ${input.cwd}`,
    `shell: ${input.shell} -lc`,
    `exitCode: ${input.exitCode === null ? 'none' : input.exitCode}`,
    `durationMs: ${input.durationMs}`,
    input.timedOut ? `timedOut: true (terminated process group after ${input.timeoutMs} ms)` : 'timedOut: false',
    input.cancelled ? 'cancelled: true' : 'cancelled: false',
  ].join('\n');
  const stdoutHeader = `stdout${input.stdoutTruncated ? ' (trailing output only)' : ''}:`;
  const stderrHeader = `stderr${input.stderrTruncated ? ' (trailing output only)' : ''}:`;
  const stdout = input.stdout || '(empty)';
  const stderr = input.stderr || '(empty)';
  const full = [metadata, stdoutHeader, stdout, stderrHeader, stderr].join('\n');
  if (limit === undefined || full.length <= limit) return full;

  const tailMetadata = [
    `shell: ${input.shell} -lc`,
    `exitCode: ${input.exitCode === null ? 'none' : input.exitCode}`,
    `durationMs: ${input.durationMs}`,
    input.timedOut ? `timedOut: true (terminated process group after ${input.timeoutMs} ms)` : 'timedOut: false',
    input.cancelled ? 'cancelled: true' : 'cancelled: false',
  ];
  let fieldLines = ['command: ', 'cwd: '];
  let emptyScaffold = [...fieldLines, ...tailMetadata, stdoutHeader, '', stderrHeader, ''].join('\n');
  if (emptyScaffold.length > limit) {
    fieldLines = ['command: '];
    emptyScaffold = [...fieldLines, ...tailMetadata, stdoutHeader, '', stderrHeader, ''].join('\n');
  }
  if (emptyScaffold.length > limit) {
    fieldLines = [];
    emptyScaffold = [...tailMetadata, stdoutHeader, '', stderrHeader, ''].join('\n');
  }
  if (emptyScaffold.length > limit) {
    const essential = [`exitCode: ${input.exitCode === null ? 'none' : input.exitCode}`, `durationMs: ${input.durationMs}`].join('\n');
    return boundHostCommandOutput(essential, limit);
  }

  const fieldBudget = Math.floor((limit - emptyScaffold.length) * 0.4);
  const hasCwd = fieldLines.length === 2;
  const commandBudget = hasCwd ? Math.ceil(fieldBudget * 0.6) : fieldBudget;
  const cwdBudget = Math.max(0, fieldBudget - commandBudget);
  const fields = fieldLines.length === 0
    ? []
    : hasCwd
      ? [`command: ${boundedField(input.command, commandBudget)}`, `cwd: ${boundedField(input.cwd, cwdBudget)}`]
      : [`command: ${boundedField(input.command, commandBudget)}`];
  const metadataLines = [...fields, ...tailMetadata];
  const scaffold = [...metadataLines, stdoutHeader, '', stderrHeader, ''].join('\n');
  const bodyBudget = Math.max(0, limit - scaffold.length);
  const totalBodyChars = stdout.length + stderr.length;
  const stdoutBudget = totalBodyChars === 0 ? 0 : Math.floor(bodyBudget * stdout.length / totalBodyChars);
  const stderrBudget = bodyBudget - stdoutBudget;
  return [
    ...metadataLines,
    stdoutHeader,
    boundedTail(stdout, stdoutBudget),
    stderrHeader,
    boundedTail(stderr, stderrBudget),
  ].join('\n');
}

@Injectable()
export class ChatHostCommandService {
  async run(input: unknown, signal?: AbortSignal, config = readChatHostCommandConfig(), onProgress?: (text: string) => Promise<void>): Promise<ChatHostCommandResult> {
    let parsed: ChatHostCommandInput;
    try {
      parsed = parseChatHostCommandInput(input, config);
    } catch (error) {
      return rejectedResult(input, config, error instanceof Error ? error.message : 'The command input is invalid.');
    }
    if (signal?.aborted) return cancelledResult(parsed, config, 'Command cancelled before it started.');

    return this.execute(parsed, config, signal, onProgress);
  }

  private execute(input: ChatHostCommandInput, config: ChatHostCommandConfig, signal?: AbortSignal, onProgress?: (text: string) => Promise<void>): Promise<ChatHostCommandResult> {
    const startedAt = Date.now();
    const stdout = new BoundedTail(config.streamChars);
    const stderr = new BoundedTail(config.streamChars);
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const argv = [config.shell, ...HOST_COMMAND_SHELL_ARGS, input.command];
    return new Promise<ChatHostCommandResult>((resolvePromise, reject) => {
      let progressTail = Promise.resolve();
      let lastProgressAt = 0;
      const reportProgress = (force = false) => {
        if (!onProgress || (!force && Date.now() - lastProgressAt < 100)) return;
        const text = [stdout.value(), stderr.value()].filter(Boolean).join('\n').slice(-2000);
        if (!text) return;
        lastProgressAt = Date.now();
        progressTail = progressTail.then(() => onProgress(text));
        void progressTail.catch(() => undefined);
      };
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let killHandle: NodeJS.Timeout | undefined;
      let failSafeHandle: NodeJS.Timeout | undefined;
      let child: ChildProcess | undefined;

      const terminate = (graceful: boolean) => {
        if (!child?.pid) return;
        const signalName = graceful ? 'SIGTERM' : 'SIGKILL';
        try { process.kill(-child.pid, signalName); }
        catch { try { process.kill(child.pid, signalName); } catch { /* the process group already exited */ } }
      };
      const interrupt = (reason: 'timeout' | 'cancel') => {
        if (settled || timedOut || cancelled) return;
        if (reason === 'timeout') timedOut = true;
        else cancelled = true;
        terminate(true);
        killHandle = setTimeout(() => terminate(false), 1_000);
        failSafeHandle = setTimeout(() => {
          child?.stdout?.destroy();
          child?.stderr?.destroy();
          finish(null);
        }, 3_000);
      };
      const finish = (exitCode: number | null, spawnError?: Error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
        if (killHandle) clearTimeout(killHandle);
        if (failSafeHandle) clearTimeout(failSafeHandle);
        stdout.append(stdoutDecoder.end());
        stderr.append(stderrDecoder.end());
        if (spawnError) stderr.append(`${spawnError.message}\n`);
        if (cancelled) stderr.append('Command cancelled before completion.\n');
        const stdoutText = stdout.value();
        const stderrText = stderr.value();
        const durationMs = Date.now() - startedAt;
        const formatted = {
          command: input.command,
          cwd: input.cwd,
          shell: config.shell,
          exitCode,
          durationMs,
          stdout: stdoutText,
          stderr: stderrText,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          timedOut,
          cancelled,
          timeoutMs: input.timeoutMs,
        };
        const fullOutput = formatChatHostCommandOutput(formatted);
        const output = formatChatHostCommandOutput(formatted, config.outputChars);
        const result: ChatHostCommandResult = {
          status: exitCode === 0 && !timedOut && !cancelled && !spawnError ? 'completed' : 'failed',
          command: input.command,
          cwd: input.cwd,
          shell: config.shell,
          argv,
          exitCode: spawnError ? null : exitCode,
          stdout: stdoutText,
          stderr: stderrText,
          output,
          durationMs,
          timedOut,
          cancelled,
          rejected: false,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          outputTruncated: fullOutput.length > output.length,
        };
        reportProgress(true);
        void progressTail.then(() => resolvePromise(result), reject);
      };
      const onAbort = () => interrupt('cancel');

      try {
        child = spawn(config.shell, [...HOST_COMMAND_SHELL_ARGS, input.command], {
          cwd: input.cwd,
          env: buildHostCommandEnvironment(process.env, input.cwd),
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        finish(null, error instanceof Error ? error : new Error(String(error)));
        return;
      }
      child.stdout?.on('data', (chunk: Buffer) => { stdout.append(stdoutDecoder.write(chunk)); reportProgress(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr.append(stderrDecoder.write(chunk)); reportProgress(); });
      child.once('error', (error) => finish(null, error));
      child.once('close', (exitCode) => finish(exitCode));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      timeoutHandle = setTimeout(() => interrupt('timeout'), input.timeoutMs);
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function rejectedResult(input: unknown, config: ChatHostCommandConfig, reason: string): ChatHostCommandResult {
  const record = asRecord(input);
  const command = typeof record?.command === 'string' ? record.command : '';
  const requestedCwd = typeof record?.cwd === 'string' && record.cwd.trim() ? record.cwd.trim() : config.defaultCwd;
  const fullOutput = [`command: ${command || '(missing)'}`, `cwd: ${requestedCwd}`, `Rejected: ${reason}`].join('\n');
  const output = boundHostCommandOutput(fullOutput, config.outputChars);
  return {
    status: 'failed',
    command,
    cwd: requestedCwd,
    shell: config.shell,
    argv: [config.shell, ...HOST_COMMAND_SHELL_ARGS, command],
    exitCode: null,
    stdout: '',
    stderr: '',
    output,
    durationMs: 0,
    timedOut: false,
    cancelled: false,
    rejected: true,
    stdoutTruncated: false,
    stderrTruncated: false,
    outputTruncated: fullOutput.length > output.length,
  };
}

function cancelledResult(input: ChatHostCommandInput, config: ChatHostCommandConfig, reason: string): ChatHostCommandResult {
  const fullOutput = [`command: ${input.command}`, `cwd: ${input.cwd}`, `Cancelled: ${reason}`].join('\n');
  const output = boundHostCommandOutput(fullOutput, config.outputChars);
  return {
    status: 'failed',
    command: input.command,
    cwd: input.cwd,
    shell: config.shell,
    argv: [config.shell, ...HOST_COMMAND_SHELL_ARGS, input.command],
    exitCode: null,
    stdout: '',
    stderr: '',
    output,
    durationMs: 0,
    timedOut: false,
    cancelled: true,
    rejected: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    outputTruncated: fullOutput.length > output.length,
  };
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback;
}

class BoundedTail {
  private text = '';
  truncated = false;

  constructor(private readonly limit: number) {}

  append(chunk: string): void {
    if (!chunk) return;
    this.text += chunk;
    if (this.text.length > this.limit) {
      this.text = this.text.slice(-this.limit);
      this.truncated = true;
    }
  }

  value(): string { return this.text; }
}

function boundedTail(text: string, limit: number): string {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  const marker = '[truncated; showing trailing text]';
  if (limit <= marker.length) return text.slice(-limit);
  return `${marker}${text.slice(-(limit - marker.length))}`;
}

function boundedField(value: string, limit: number): string {
  if (limit <= 0) return '';
  if (value.length <= limit) return value;
  if (limit <= FIELD_TRUNCATION_MARKER.length) return value.slice(0, limit);
  const remaining = limit - FIELD_TRUNCATION_MARKER.length;
  const head = Math.ceil(remaining / 2);
  const tail = remaining - head;
  return `${value.slice(0, head)}${FIELD_TRUNCATION_MARKER}${tail > 0 ? value.slice(-tail) : ''}`;
}
