import { BadRequestException, Injectable } from '@nestjs/common';
import { isAbsolute, relative } from 'node:path';
import type { GatewayToolDefinition } from '@worklite/model-gateway';
import type { AgentTeamRoleId, CommandExecutionView } from '@worklite/contracts';
import { CommandsService, type CommandReservation } from '../commands/commands.service';

type BuiltinExecution = { execution: CommandExecutionView; output: string };
type StartOptions = { cwd?: string; reserveCommand?: CommandReservation };

const READ_ONLY_TOOL_NAMES = ['read', 'glob', 'grep', 'process_reference'];
const ROLE_ALLOWED_TOOL_NAMES: Partial<Record<string, readonly string[]>> = {
  planner: [...READ_ONLY_TOOL_NAMES, 'read_executor_document'],
  'worktree-manager': [...READ_ONLY_TOOL_NAMES, 'read_executor_document'],
  test_designer: [...READ_ONLY_TOOL_NAMES, 'read_executor_document'],
  developer: ['bash', 'read', 'write', 'glob', 'grep', 'process_reference', 'read_executor_document'],
  test_author: ['read', 'write', 'glob', 'grep', 'process_reference', 'read_executor_document'],
  test_runner: ['bash', 'read', 'write', 'glob', 'grep', 'read_executor_document'],
  reviewer: ['bash', ...READ_ONLY_TOOL_NAMES, 'read_executor_document'],
};

export function selectBuiltinToolNames(role: AgentTeamRoleId, requestedToolNames: readonly string[]): string[] {
  const allowed = new Set(ROLE_ALLOWED_TOOL_NAMES[role] ?? []);
  return [...new Set(requestedToolNames)].filter((name) => allowed.has(name));
}

const definitions: GatewayToolDefinition[] = [
  { name: 'bash', description: 'Run a shell command and return combined output.', inputSchema: { type: 'object', additionalProperties: false, required: ['command'], properties: { command: { type: 'string' } } } },
  { name: 'read', description: 'Read a UTF-8 text file. For a large file, use 1-based inclusive startLine and endLine to read a focused, line-numbered excerpt.', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } } } },
  { name: 'write', description: 'Write UTF-8 text to a file.', inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'glob', description: 'Find files matching a project-relative glob pattern. Includes hidden files, respects ignore rules, and excludes .git.', inputSchema: { type: 'object', additionalProperties: false, required: ['pattern'], properties: { pattern: { type: 'string' } } } },
  { name: 'grep', description: 'Search files with a regular expression. Combine independent patterns for the same path with regex alternation (e.g. foo|bar) in one search; narrow the path to limit output.', inputSchema: { type: 'object', additionalProperties: false, required: ['pattern'], properties: { pattern: { type: 'string' }, path: { type: 'string' } } } },
  { name: 'process_reference', description: 'Read a file from the pinned executor process package.', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } } },
  { name: 'read_executor_document', description: 'Read an exact immutable executor document version that was explicitly handed to this task.', inputSchema: { type: 'object', additionalProperties: false, required: ['documentId', 'revision'], properties: { documentId: { type: 'string' }, revision: { type: 'integer', minimum: 1 } } } },
];

@Injectable()
export class BuiltinAgentToolsService {
  constructor(private readonly commands: CommandsService) {}

  toolDefinitions(toolNames?: readonly string[]): readonly GatewayToolDefinition[] {
    if (toolNames === undefined) return definitions;
    const selected = new Set(toolNames);
    return definitions.filter((definition) => selected.has(definition.name));
  }

  async execute(name: string, input: unknown, options?: StartOptions): Promise<BuiltinExecution> {
    const execution = await this.start(name, input, options);
    const completed = await this.commands.waitForCompletion(execution.id);
    return { execution: completed, output: await this.commands.output(execution.id) };
  }

  async wait(commandId: string): Promise<BuiltinExecution> {
    const execution = await this.commands.waitForCompletion(commandId);
    return { execution, output: await this.commands.output(commandId) };
  }

  cancel(commandId: string): Promise<CommandExecutionView> {
    return this.commands.cancel(commandId);
  }

  async start(name: string, input: unknown, options?: StartOptions): Promise<CommandExecutionView> {
    const args = asRecord(input);
    let command: string;
    switch (name) {
      case 'bash': command = requiredString(args?.command, 'command'); break;
      case 'read': {
        const path = requiredString(args?.path, 'path');
        const start = optionalLine(args?.startLine, 'startLine');
        const end = optionalLine(args?.endLine, 'endLine');
        if (start !== undefined && end !== undefined && end < start) throw new BadRequestException('endLine must be at least startLine.');
        const script = start === undefined && end === undefined
          ? "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))"
          : "const lines = require('fs').readFileSync(process.argv[1], 'utf8').split('\\n'); if (lines.at(-1) === '') lines.pop(); const start = Number(process.argv[2]); const end = Number(process.argv[3]); process.stdout.write(lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\\n'))";
        command = `node -e ${shellQuote(script)} ${shellQuote(path)}${start !== undefined || end !== undefined ? ` ${start ?? 1} ${end ?? Number.MAX_SAFE_INTEGER}` : ''}`;
        break;
      }
      case 'write': {
        requiredString(args?.content, 'content');
        command = `node -e ${shellQuote("require('fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'))")} ${shellQuote(requiredString(args?.path, 'path'))} ${shellQuote(Buffer.from(args!.content as string, 'utf8').toString('base64'))}`;
        break;
      }
      case 'glob': {
        let pattern = requiredString(args?.pattern, 'pattern');
        if (isAbsolute(pattern)) {
          if (!options?.cwd) throw new BadRequestException('An absolute glob requires a project directory.');
          pattern = relative(options.cwd, pattern);
          if (pattern === '..' || pattern.startsWith('../') || isAbsolute(pattern)) {
            throw new BadRequestException('The glob pattern must be inside the project directory.');
          }
        }
        pattern = pattern.replace(/^\.\//, '');
        // ripgrep returns 1 for an empty result; glob historically treats that as success.
        command = `rg --files --hidden --glob ${shellQuote(pattern)} --glob '!.git'; glob_exit_code=$?; if [ "$glob_exit_code" -eq 1 ]; then exit 0; else exit "$glob_exit_code"; fi`;
        break;
      }
      case 'grep': command = `rg --line-number --no-heading -- ${shellQuote(requiredString(args?.pattern, 'pattern'))} ${shellQuote(typeof args?.path === 'string' && args.path.trim() ? args.path.trim() : '.')}`; break;
      case 'process_reference': throw new BadRequestException('Process references are read directly by the isolated Agent invocation.');
      default: throw new BadRequestException('Unknown built-in Agent tool.');
    }
    if (options?.reserveCommand) {
      if (!options.cwd) throw new BadRequestException('A project directory is required for journaled built-in Agent tools.');
      return this.commands.createWithReservation(command, options.cwd, options.reserveCommand);
    }
    return options?.cwd
      ? this.commands.createWithReservation(command, options.cwd, () => undefined)
      : this.commands.create({ command });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required.`);
  return value.trim();
}

function optionalLine(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new BadRequestException(`${field} must be a positive integer.`);
  return value as number;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
