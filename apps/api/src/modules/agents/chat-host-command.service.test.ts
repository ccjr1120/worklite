import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ChatHostCommandService,
  boundHostCommandOutput,
  buildHostCommandEnvironment,
  formatChatHostCommandOutput,
  parseChatHostCommandInput,
  readChatHostCommandConfig,
  type ChatHostCommandConfig,
} from './chat-host-command.service';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'worklite-chat-host-command-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function config(overrides: Partial<ChatHostCommandConfig> = {}): ChatHostCommandConfig {
  return {
    shell: '/bin/zsh',
    defaultCwd: root,
    timeoutMs: 120_000,
    maxTimeoutMs: 900_000,
    outputChars: 20_000,
    streamChars: 40_000,
    ...overrides,
  };
}

describe('Chat host command input', () => {
  it.each([
    'ls -la',
    'node -v',
    'printf "hello\\n" | tr a-z A-Z > result.txt',
    'echo "$(pwd)" && cat notes.txt',
    'npx skills add vercel-labs/agent-skills --skill frontend-design --agent codex',
  ])('accepts arbitrary shell syntax: %s', (command) => {
    expect(parseChatHostCommandInput({ command }, config()).command).toBe(command);
  });

  it('rejects malformed input and unknown fields', () => {
    expect(() => parseChatHostCommandInput(null, config())).toThrow(/one JSON object/i);
    expect(() => parseChatHostCommandInput({}, config())).toThrow(/shell command is required/i);
    expect(() => parseChatHostCommandInput({ command: '   ' }, config())).toThrow(/shell command is required/i);
    expect(() => parseChatHostCommandInput({ command: 'pwd', extra: true }, config())).toThrow(/Unknown input field: extra/i);
    expect(() => parseChatHostCommandInput({ command: `printf '${String.fromCharCode(0)}'` }, config())).toThrow(/NUL/i);
    expect(() => parseChatHostCommandInput({ command: 'x'.repeat(20_001) }, config())).toThrow(/at most 20000/i);
  });

  it('uses the configured default cwd and canonicalizes an existing directory', () => {
    expect(parseChatHostCommandInput({ command: 'pwd' }, config()).cwd).toBe(root);
    expect(parseChatHostCommandInput({ command: 'pwd', cwd: root }, config()).cwd).toBe(root);
  });

  it('rejects relative, missing and non-directory cwd values', () => {
    const file = join(root, 'notes.txt');
    writeFileSync(file, 'notes');
    expect(() => parseChatHostCommandInput({ command: 'pwd', cwd: 'relative/path' }, config())).toThrow(/absolute path/i);
    expect(() => parseChatHostCommandInput({ command: 'pwd', cwd: join(root, 'missing') }, config())).toThrow(/existing, accessible directory/i);
    expect(() => parseChatHostCommandInput({ command: 'pwd', cwd: file }, config())).toThrow(/existing directory/i);
    expect(() => parseChatHostCommandInput({ command: 'pwd', cwd: ' ' }, config())).toThrow(/non-empty absolute directory/i);
  });

  it('validates and caps per-call timeouts', () => {
    expect(parseChatHostCommandInput({ command: 'pwd', timeoutMs: 250 }, config()).timeoutMs).toBe(250);
    expect(() => parseChatHostCommandInput({ command: 'pwd', timeoutMs: 99 }, config())).toThrow(/at least 100/i);
    expect(() => parseChatHostCommandInput({ command: 'pwd', timeoutMs: 1.5 }, config())).toThrow(/integer/i);
    expect(() => parseChatHostCommandInput({ command: 'pwd', timeoutMs: 900_001 }, config())).toThrow(/at most 900000/i);
    expect(() => parseChatHostCommandInput({ command: 'pwd', timeoutMs: 5_000 }, config({ maxTimeoutMs: 1_000 }))).toThrow(/at most 1000/i);
  });

  it('reads bounded configuration defaults and clamps environment overrides', () => {
    const home = join(root, 'home');
    const defaults = readChatHostCommandConfig({}, home);
    expect(defaults).toMatchObject({ shell: '/bin/zsh', defaultCwd: home, timeoutMs: 120_000, maxTimeoutMs: 900_000, outputChars: 20_000, streamChars: 40_000 });

    const clamped = readChatHostCommandConfig({
      WORKLITE_CHAT_HOST_COMMAND_DEFAULT_CWD: root,
      WORKLITE_CHAT_HOST_COMMAND_TIMEOUT_MS: '9999999',
      WORKLITE_CHAT_HOST_COMMAND_MAX_TIMEOUT_MS: '5000',
      WORKLITE_CHAT_HOST_COMMAND_OUTPUT_CHARS: '1',
      WORKLITE_CHAT_HOST_COMMAND_STREAM_CHARS: '9999999',
    }, home);
    expect(clamped).toMatchObject({ defaultCwd: root, timeoutMs: 5_000, maxTimeoutMs: 5_000, outputChars: 200, streamChars: 200_000 });
  });

  it('builds a minimal child environment without WorkLite or provider secrets', () => {
    const env = buildHostCommandEnvironment({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: root,
      USER: 'example',
      TMPDIR: join(root, 'tmp'),
      LANG: 'en_US.UTF-8',
      WORKLITE_API_TOKEN: 'worklite-secret',
      SECRET_ENCRYPTION_KEY: 'encryption-secret',
      OPENAI_API_KEY: 'provider-secret',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      NODE_OPTIONS: '--require=/tmp/untrusted.js',
    }, root);

    expect(env).toMatchObject({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: root,
      USER: 'example',
      TMPDIR: join(root, 'tmp'),
      LANG: 'en_US.UTF-8',
      PWD: root,
      SHELL: '/bin/zsh',
      CI: '1',
      GIT_TERMINAL_PROMPT: '0',
      npm_config_yes: 'true',
    });
    expect(env.WORKLITE_API_TOKEN).toBeUndefined();
    expect(env.SECRET_ENCRYPTION_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });
});

describe('Chat host command output', () => {
  it('bounds the final text while preserving command metadata', () => {
    const output = formatChatHostCommandOutput({
      command: 'printf stdout; printf stderr >&2; exit 3',
      cwd: root,
      shell: '/bin/zsh',
      exitCode: 3,
      durationMs: 42,
      stdout: 'a'.repeat(1_000),
      stderr: 'b'.repeat(1_000),
      stdoutTruncated: true,
      stderrTruncated: true,
      timedOut: false,
      cancelled: false,
      timeoutMs: 120_000,
    }, 500);

    expect(output.length).toBeLessThanOrEqual(500);
    expect(output).toContain('exitCode: 3');
    expect(output).toContain('durationMs: 42');
    expect(output).toContain('stdout (trailing output only):');
    expect(output).toContain('stderr (trailing output only):');
    expect(output).toContain('trailing text');
  });

  it('keeps exit code and duration when the command itself exceeds a small result limit', () => {
    const output = formatChatHostCommandOutput({
      command: `printf '${'x'.repeat(19_990)}'`,
      cwd: root,
      shell: '/bin/zsh',
      exitCode: 7,
      durationMs: 321,
      stdout: 'stdout tail',
      stderr: 'stderr tail',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      cancelled: false,
      timeoutMs: 120_000,
    }, 500);

    expect(output.length).toBeLessThanOrEqual(500);
    expect(output).toContain('command: ');
    expect(output).toContain('[truncated]');
    expect(output).toContain('exitCode: 7');
    expect(output).toContain('durationMs: 321');
    expect(output).toContain('stdout tail');
    expect(output).toContain('stderr tail');
  });

  it.each([200, 500])('preserves exit code and duration at a %i-character limit', (limit) => {
    const output = formatChatHostCommandOutput({
      command: 'x'.repeat(20_000),
      cwd: root,
      shell: '/bin/zsh',
      exitCode: 0,
      durationMs: 5,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      cancelled: false,
      timeoutMs: 120_000,
    }, limit);

    expect(output.length).toBeLessThanOrEqual(limit);
    expect(output).toContain('exitCode: 0');
    expect(output).toContain('durationMs: 5');
  });

  it('bounds a plain output tail even for a limit shorter than the marker', () => {
    expect(boundHostCommandOutput('0123456789', 5)).toBe('56789');
    const bounded = boundHostCommandOutput('a'.repeat(200), 100);
    expect(bounded.length).toBeLessThanOrEqual(100);
    expect(bounded).toContain('Output truncated');
    expect(bounded.endsWith('a')).toBe(true);
  });
});

describe('ChatHostCommandService execution', () => {
  it('executes an arbitrary command and returns real stdout, stderr, exit code and duration', async () => {
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const result = await new ChatHostCommandService().run({
        command: 'printf "hello\\n"; printf "oops\\n" >&2; exit 7',
      }, undefined, config());

      expect(result.status).toBe('failed');
      expect(result.command).toBe('printf "hello\\n"; printf "oops\\n" >&2; exit 7');
      expect(result.cwd).toBe(root);
      expect(result.argv).toEqual(['/bin/zsh', '-lc', 'printf "hello\\n"; printf "oops\\n" >&2; exit 7']);
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toBe('hello\n');
      expect(result.stderr).toBe('oops\n');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.output).toContain('exitCode: 7');
      expect(result.output).toContain('durationMs:');
      expect(result.timedOut).toBe(false);
      expect(result.cancelled).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('terminates the process group at the timeout and reports the real reason', async () => {
    const result = await new ChatHostCommandService().run({ command: 'sleep 5', timeoutMs: 150 }, undefined, config());

    expect(result.status).toBe('failed');
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.output).toContain('timedOut: true (terminated process group after 150 ms)');
  });

  it('bounds stdout, stderr and result text independently', async () => {
    const result = await new ChatHostCommandService().run({
      command: "printf 'a%.0s' {1..1000}; printf 'b%.0s' {1..1000} >&2; exit 3",
    }, undefined, config({ streamChars: 200, outputChars: 500 }));

    expect(result.exitCode).toBe(3);
    expect(result.stdout.length).toBeLessThanOrEqual(200);
    expect(result.stderr.length).toBeLessThanOrEqual(200);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(500);
    expect(result.outputTruncated).toBe(true);
    expect(result.output).toContain('exitCode: 3');
    expect(result.output).toContain('durationMs:');
  });

  it('runs independent host commands concurrently', async () => {
    const service = new ChatHostCommandService();
    // Each command waits for its peer to start: a serial queue cannot complete this handshake.
    const first = service.run({ command: 'touch first; while [ ! -f second ]; do sleep 0.01; done; printf first', timeoutMs: 2000 }, undefined, config());
    const second = service.run({ command: 'touch second; while [ ! -f first ]; do sleep 0.01; done; printf second', timeoutMs: 2000 }, undefined, config());
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.status)).toEqual(['completed', 'completed']);
    expect(results.map((result) => result.stdout)).toEqual(['first', 'second']);
  });

  it('delivers progress before completion and awaits the final callback', async () => {
    const updates: string[] = [];
    const result = await new ChatHostCommandService().run({ command: 'printf started; while [ ! -f acknowledged ]; do sleep 0.01; done; printf finished', timeoutMs: 2000 }, undefined, config(), async (text) => {
      updates.push(text);
      if (text.includes('started')) writeFileSync(join(root, 'acknowledged'), 'ok');
    });
    expect(result.status).toBe('completed');
    expect(updates[0]).toContain('started');
    expect(updates[0]).not.toContain('finished');
    expect(updates.at(-1)).toContain('finished');
  });

  it('cancels a running command and reports cancellation', async () => {
    const controller = new AbortController();
    const pending = new ChatHostCommandService().run({ command: 'sleep 5' }, controller.signal, config());
    setTimeout(() => controller.abort(), 50);
    const result = await pending;

    expect(result.status).toBe('failed');
    expect(result.cancelled).toBe(true);
    expect(result.output).toContain('cancelled: true');
    expect(result.stderr).toContain('Command cancelled before completion.');
  });

  it('bounds rejection text even when the rejected command is at its maximum length', async () => {
    const result = await new ChatHostCommandService().run({
      command: 'x'.repeat(20_000),
      unexpected: true,
    }, undefined, config({ outputChars: 200 }));

    expect(result.rejected).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(200);
    expect(result.output).toContain('Unknown input field: unexpected.');
    expect(result.outputTruncated).toBe(true);
  });
});
