import { BadRequestException } from '@nestjs/common';
import type { AgentCollaboration } from '@worklite/contracts';
import { resolveWorkflowNodeCapability } from '@worklite/workflow-engine';

export function validateAgentCapabilities(value: unknown, source: string, forbiddenTypes: readonly string[] = []): asserts value is AgentCollaboration['capabilities'] {
  if (!Array.isArray(value)) throw new BadRequestException(`Agent capabilities must be an array in ${source}.`);
  const ids = new Map<string, number>();
  for (const [index, capability] of value.entries()) {
    const field = `capabilities[${index}]`;
    if (!capability || typeof capability !== 'object' || Array.isArray(capability)) throw new BadRequestException(`Invalid Agent capability in ${source}: ${field} must be an object.`);
    if (typeof capability.id !== 'string' || !capability.id.trim()) throw new BadRequestException(`Invalid Agent capability in ${source}: ${field}.id must be a non-empty string.`);
    const previous = ids.get(capability.id);
    if (previous !== undefined) throw new BadRequestException(`Duplicate Agent capability id ${JSON.stringify(capability.id)} in ${source}: ${field}.id repeats capabilities[${previous}].id.`);
    const context = `Agent capability ${JSON.stringify(capability.id)} (${field}) in ${source}`;
    if (!capability.config || typeof capability.config !== 'object' || Array.isArray(capability.config)) throw new BadRequestException(`Invalid ${context}: config must be an object.`);
    if (forbiddenTypes.includes(capability.type)) throw new BadRequestException(`Invalid ${context}: ${capability.type} is a workflow control and cannot be used as an Agent capability.`);
    if (!resolveWorkflowNodeCapability(capability.type, capability.typeVersion)) throw new BadRequestException(`Unsupported Agent capability ${capability.type}@${capability.typeVersion} in ${source}. Capability ${JSON.stringify(capability.id)} (${field}). Update the API to a version supporting this capability.`);
    ids.set(capability.id, index);
  }
}
