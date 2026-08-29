import { BadRequestException, Injectable } from '@nestjs/common';
import type { GatewayToolDefinition } from '@worklite/model-gateway';
import type { CommandExecutionView } from '@worklite/contracts';
import { CommandsService } from '../commands/commands.service';

type BuiltinExecution = { execution: CommandExecutionView; output: string };

const definitions: GatewayToolDefinition[] = [
  { name: 'bash', description: 'Run a shell command and return combined output.', inputSchema: { type: 'object', additionalProperties: false, required: ['command'], properties: { command: { type: 'string' } } } },
  { name: 'read', description: 'Read a UTF-8 text file.', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } } },
  { name: 'write', description: 'Write UTF-8 text to a file.', inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'glob', description: 'Find files matching a glob pattern.', inputSchema: { type: 'object', additionalProperties: false, required: ['pattern'], properties: { pattern: { type: 'string' } } } },
  { name: 'grep', description: 'Search files with a regular expression.', inputSchema: { type: 'object', additionalProperties: false, required: ['pattern'], properties: { pattern: { type: 'string' }, path: { type: 'string' } } } },
];

@Injectable()
export class BuiltinAgentToolsService {
  constructor(private readonly commands: CommandsService) {}

  toolDefinitions(): readonly GatewayToolDefinition[] {
    return definitions;
  }

  async execute(name: string, input: unknown): Promise<BuiltinExecution> {
    const execution = await this.start(name, input);
    const completed = await this.commands.waitForCompletion(execution.id);
    return { execution: completed, output: await this.commands.output(execution.id) };
  }

  async start(name: string, input: unknown): Promise<CommandExecutionView> {
    const args = asRecord(input);
    let command: string;
    switch (name) {
      case 'bash': command = requiredString(args?.command, 'command'); break;
      case 'read': command = `node -e ${shellQuote("process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))")} ${shellQuote(requiredString(args?.path, 'path'))}`; break;
      case 'write': command = `node -e ${shellQuote("require('fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'))")} ${shellQuote(requiredString(args?.path, 'path'))} ${shellQuote(Buffer.from(requiredString(args?.content, 'content'), 'utf8').toString('base64'))}`; break;
      case 'glob': command = `find . -type f -name ${shellQuote(requiredString(args?.pattern, 'pattern'))}`; break;
      case 'grep': command = `rg --line-number --no-heading -- ${shellQuote(requiredString(args?.pattern, 'pattern'))} ${shellQuote(typeof args?.path === 'string' && args.path.trim() ? args.path.trim() : '.')}`; break;
      default: throw new BadRequestException('Unknown built-in Agent tool.');
    }
    return this.commands.create({ command });
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
