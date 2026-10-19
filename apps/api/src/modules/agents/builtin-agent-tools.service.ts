import { BadRequestException, Injectable } from '@nestjs/common';
import type { GatewayToolDefinition } from '@worklite/model-gateway';
import type { AgentTeamRoleId, CommandExecutionView } from '@worklite/contracts';
import { CommandsService, type CommandReservation } from '../commands/commands.service';

type BuiltinExecution = { execution: CommandExecutionView; output: string };
type StartOptions = { cwd?: string; reserveCommand?: CommandReservation };

const READ_ONLY_TOOL_NAMES = ['read', 'glob', 'grep', 'process_reference'];
const ROLE_ALLOWED_TOOL_NAMES: Partial<Record<string, readonly string[]>> = {
  planner: [...READ_ONLY_TOOL_NAMES, 'read_team_document'],
  'worktree-manager': [...READ_ONLY_TOOL_NAMES, 'read_team_document'],
  test_designer: [...READ_ONLY_TOOL_NAMES, 'read_team_document'],
  developer: ['bash', 'read', 'write', 'glob', 'grep', 'process_reference', 'read_team_document'],
  test_author: ['read', 'write', 'glob', 'grep', 'process_reference', 'read_team_document'],
  test_runner: ['bash', 'read', 'write', 'glob', 'grep', 'read_team_document'],
  reviewer: [...READ_ONLY_TOOL_NAMES, 'read_team_document'],
};

export function selectBuiltinToolNames(role: AgentTeamRoleId, requestedToolNames: readonly string[]): string[] {
  const allowed = new Set(ROLE_ALLOWED_TOOL_NAMES[role] ?? []);
  return [...new Set(requestedToolNames)].filter((name) => allowed.has(name));
}

const definitions: GatewayToolDefinition[] = [
  { name: 'bash', description: 'Run a shell command and return combined output.', inputSchema: { type: 'object', additionalProperties: false, required: ['command'], properties: { command: { type: 'string' } } } },
  { name: 'read', description: 'Read a UTF-8 text file.', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } } },
  { name: 'write', description: 'Write UTF-8 text to a file.', inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'glob', description: 'Find files matching a glob pattern.', inputSchema: { type: 'object', additionalProperties: false, required: ['pattern'], properties: { pattern: { type: 'string' } } } },
  { name: 'grep', description: 'Search files with a regular expression.', inputSchema: { type: 'object', additionalProperties: false, required: ['pattern'], properties: { pattern: { type: 'string' }, path: { type: 'string' } } } },
  { name: 'process_reference', description: 'Read a file from the pinned Agent Team process package.', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } } },
  { name: 'read_team_document', description: 'Read an exact immutable Team document version that was explicitly handed to this task.', inputSchema: { type: 'object', additionalProperties: false, required: ['documentId', 'revision'], properties: { documentId: { type: 'string' }, revision: { type: 'integer', minimum: 1 } } } },
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
      case 'read': command = `node -e ${shellQuote("process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))")} ${shellQuote(requiredString(args?.path, 'path'))}`; break;
      case 'write': {
        requiredString(args?.content, 'content');
        command = `node -e ${shellQuote("require('fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'))")} ${shellQuote(requiredString(args?.path, 'path'))} ${shellQuote(Buffer.from(args!.content as string, 'utf8').toString('base64'))}`;
        break;
      }
      case 'glob': command = `find . -type f -name ${shellQuote(requiredString(args?.pattern, 'pattern'))}`; break;
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
