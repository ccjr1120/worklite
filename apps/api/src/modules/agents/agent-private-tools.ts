import { BadRequestException } from '@nestjs/common';
import type { AgentCollaboration } from '@worklite/contracts';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const reserved = new Set(['use_sub_agent_tool', 'read_result', 'store_result', 'run_sub_agent', 'run_sub_agents', 'use_capability', 'skill_script', 'mcp', 'bash', 'read', 'write', 'glob', 'grep', 'process_reference', 'read_coder_document', 'update_plan', 'ask_user']);

export async function validatePrivateTools(config: AgentCollaboration): Promise<void> {
  if (config.privateTools === undefined) return;
  if (!Array.isArray(config.privateTools)) throw new BadRequestException('privateTools must be an array.');
  const names = new Set<string>();
  for (const tool of config.privateTools) {
    if (!tool || typeof tool.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tool.name) || reserved.has(tool.name) || names.has(tool.name)) throw new BadRequestException('A private tool name is invalid, reserved or duplicated.');
    names.add(tool.name);
    if (typeof tool.description !== 'string' || !tool.description.trim() || !tool.inputSchema || tool.inputSchema.type !== 'object' || Array.isArray(tool.inputSchema)) throw new BadRequestException('Private tools require a description and object inputSchema.');
    const handler = tool.handler;
    if (handler?.kind === 'capability') {
      if (!config.capabilities.some((item) => item.id === handler.capabilityId)) throw new BadRequestException('A private tool capability must belong to this Agent.');
    } else if (handler?.kind === 'command') {
      if (typeof handler.command !== 'string' || !handler.command.trim() || typeof handler.workingDirectory !== 'string' || !isAbsolute(handler.workingDirectory) || !(await stat(handler.workingDirectory).catch(() => null))?.isDirectory()) throw new BadRequestException('A private command tool requires a command and existing absolute workingDirectory.');
    } else throw new BadRequestException('Private tool handler must be capability or command.');
  }
}

// Model arguments are data, never interpolated into the saved shell program.
export function privateToolCommand(command: string, input: unknown): string {
  const encoded = Buffer.from(JSON.stringify(input ?? {})).toString('base64');
  return `export WORKLITE_TOOL_INPUT_BASE64='${encoded}'\n${command}`;
}
