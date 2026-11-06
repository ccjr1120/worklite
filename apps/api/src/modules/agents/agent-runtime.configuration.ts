import { BadRequestException } from '@nestjs/common';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { AgentRuntimeConfiguration } from '@worklite/contracts';

export async function validateAgentRuntime(value: unknown): Promise<AgentRuntimeConfiguration> {
  return parseAgentRuntime(value);
}

// File discovery and API writes must accept exactly the same runtime configuration.
export function parseAgentRuntime(value: unknown): AgentRuntimeConfiguration {
  if (value === undefined) return { kind: 'native' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Agent runtime must be a configuration object.');
  const runtime = value as Record<string, unknown>;
  if (runtime.kind === 'native') return { kind: 'native' };
  if (runtime.kind !== 'claude' && runtime.kind !== 'codex') throw new BadRequestException('Agent runtime must be native, claude or codex.');
  if (runtime.approvalPolicy !== undefined && runtime.approvalPolicy !== 'auto' && runtime.approvalPolicy !== 'ask') throw new BadRequestException('Agent approvalPolicy must be auto or ask.');
  if (runtime.projectDirectory === undefined || runtime.projectDirectory === '') return { kind: runtime.kind, projectDirectory: '', ...(runtime.approvalPolicy ? { approvalPolicy: runtime.approvalPolicy as 'auto' | 'ask' } : {}) };
  if (typeof runtime.projectDirectory !== 'string' || !isAbsolute(runtime.projectDirectory)) throw new BadRequestException('Agent runtime.projectDirectory must be an absolute existing directory.');
  let directory: string;
  try {
    directory = realpathSync(runtime.projectDirectory);
    if (!statSync(directory).isDirectory()) throw new Error('Not a directory');
  } catch { throw new BadRequestException('Agent runtime.projectDirectory must be an existing directory.'); }
  return { kind: runtime.kind, projectDirectory: directory, ...(runtime.approvalPolicy ? { approvalPolicy: runtime.approvalPolicy as 'auto' | 'ask' } : {}) };
}
