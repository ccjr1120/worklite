import { BadRequestException } from '@nestjs/common';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { AgentRuntimeConfiguration } from '@worklite/contracts';

export async function validateAgentRuntime(value: unknown): Promise<AgentRuntimeConfiguration> {
  if (value === undefined) return { kind: 'native' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Agent runtime must be a configuration object.');
  const runtime = value as Record<string, unknown>;
  if (runtime.kind === 'native') return { kind: 'native' };
  if (runtime.kind !== 'claude' && runtime.kind !== 'codex') throw new BadRequestException('Agent runtime must be native, claude or codex.');
  if (typeof runtime.projectDirectory !== 'string' || !isAbsolute(runtime.projectDirectory)) throw new BadRequestException('An engine-backed Agent requires an absolute existing projectDirectory.');
  const directory = await realpath(runtime.projectDirectory).catch(() => null);
  if (!directory || !(await stat(directory).catch(() => null))?.isDirectory()) throw new BadRequestException('Agent projectDirectory must be an existing directory.');
  if (runtime.approvalPolicy !== undefined && runtime.approvalPolicy !== 'auto' && runtime.approvalPolicy !== 'ask') throw new BadRequestException('Agent approvalPolicy must be auto or ask.');
  return { kind: runtime.kind, projectDirectory: directory, ...(runtime.approvalPolicy ? { approvalPolicy: runtime.approvalPolicy as 'auto' | 'ask' } : {}) };
}
