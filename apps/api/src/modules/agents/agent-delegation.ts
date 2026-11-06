import { BadRequestException } from '@nestjs/common';
import type { AgentCollaboration } from '@worklite/contracts';

// Per-invocation changes never mutate the saved specialist template or grant new tools.
export type DelegationOverrides = {
  skillIds?: string[];
  mcpServerIds?: string[];
  builtinToolNames?: string[];
  requiredSkillIds?: string[];
  timeoutMs?: number;
  instructions?: string;
  model?: string;
  outputFormat?: 'text' | 'json';
  outputContract?: string[];
  allowEmptyOutputKeys?: string[];
  limits?: AgentCollaboration['limits'];
};
export const delegationOverridesSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    skillIds: { type: 'array', items: { type: 'string' }, description: 'Use only these assigned Skills for this invocation.' },
    mcpServerIds: { type: 'array', items: { type: 'string' } },
    builtinToolNames: { type: 'array', items: { type: 'string' } },
    requiredSkillIds: { type: 'array', items: { type: 'string' }, description: 'Override template research prerequisites for this invocation. Explicit user evidence requirements still apply.' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 1800000, description: 'Deadline for this invocation, including tools, in milliseconds.' },
    instructions: { type: 'string', description: 'Replace the specialist template instructions for this invocation only. Task and platform constraints still apply.' },
    model: { type: 'string', description: 'Choose a model from this specialist’s declared available models.' },
    outputFormat: { type: 'string', enum: ['text', 'json'] },
    outputContract: { type: 'array', items: { type: 'string' }, description: 'Required JSON keys for this task; [] removes the template contract.' },
    allowEmptyOutputKeys: { type: 'array', items: { type: 'string' } },
    limits: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['maxToolCalls', 'maxToolRounds', 'maxToolResultChars', 'maxOutputTokens'].map((key) => [key, { type: 'integer', minimum: 1, maximum: key === 'maxToolRounds' ? 100 : key === 'maxToolCalls' ? 128 : key === 'maxOutputTokens' ? Number.MAX_SAFE_INTEGER : 100000 }])) },
  },
};
export function delegationOverrides(value: unknown): DelegationOverrides {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('overrides must be an object.');
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!Object.hasOwn(delegationOverridesSchema.properties, key)) throw new BadRequestException(`Unsupported invocation override: ${key}.`);
  for (const key of ['instructions', 'model']) if (input[key] !== undefined && (typeof input[key] !== 'string' || !(input[key] as string).trim())) throw new BadRequestException(`${key} must be nonempty text.`);
  if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== 'number' || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 1800000)) throw new BadRequestException('Invalid timeoutMs.');
  if (input.outputFormat !== undefined && !['text', 'json'].includes(String(input.outputFormat))) throw new BadRequestException('Invalid outputFormat.');
  for (const key of ['outputContract', 'allowEmptyOutputKeys', 'skillIds', 'mcpServerIds', 'builtinToolNames', 'requiredSkillIds']) if (input[key] !== undefined && (!Array.isArray(input[key]) || !(input[key] as unknown[]).every((item) => typeof item === 'string' && item.trim()))) throw new BadRequestException(`${key} must be a string array.`);
  if (input.limits !== undefined) {
    if (!input.limits || typeof input.limits !== 'object' || Array.isArray(input.limits)) throw new BadRequestException('limits must be an object.');
    for (const [key, limit] of Object.entries(input.limits)) {
      const maximum = key === 'maxToolRounds' ? 100 : key === 'maxToolCalls' ? 128 : key === 'maxOutputTokens' ? Number.MAX_SAFE_INTEGER : 100000;
      if (!['maxToolCalls', 'maxToolRounds', 'maxToolResultChars', 'maxOutputTokens'].includes(key) || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new BadRequestException(`Invalid invocation limit: ${key}.`);
    }
  }
  return input as DelegationOverrides;
}

export class DelegationFailure extends Error {
  constructor(readonly details: { kind: 'output_contract' | 'execution'; rawOutput: string; partialResult?: unknown; skillCalls: unknown[]; toolCalls: unknown[] }, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export const TASK_OWNERSHIP_PROMPT = `You own the user's entire task and its final delivery. Sub-Agents are optional specialist templates used for parallelism and focused work, not mandatory stages or judges of task success.
For follow-up questions about completed work, first answer from your saved conversation, results and tool evidence. Read referenced results with read_result when needed. Do not launch fresh investigation just to explain work already performed. If evidence is missing, ask the original sub-Agent by passing its exact runId to run_sub_agent with the focused question; this continues its saved context. If that context is unavailable, report the limitation rather than silently launching replacement work. Only investigate new or changed facts when the question requires it.
Inspect their effective instructions and output requirements before delegation. You may replace a specialist's instructions, output contract, model or limits for one invocation using overrides; saved templates are unchanged. You may also handle the work yourself. use_sub_agent_tool lets you inspect and directly use a specialist’s assigned tools without invoking its model.
A failed sub-Agent is an intermediate result, not a failed user task. Read its failure resultRef: reuse rawOutput, partialResult and tool evidence. Repair formatting or field names yourself using store_result, supplement only missing evidence, adjust the next invocation, or take over. Explicit user requirements always remain binding when you override template research prerequisites. Never invent missing facts or blindly repeat research. Read referenced content with read_result; a textual mention of a resultRef does not deliver its contents to another Agent, so pass actual context or a structured $result reference.
For controllable engine-backed specialists, launch run_sub_agent with background:true, retain its exact runId, and use pause_sub_agent/resume_sub_agent/wait_sub_agent for that instance. Pause preserves the saved engine session and existing files; it does not undo external effects or freeze a process. Wait for results before claiming completion. Controls are available only while the owning execution is alive.
Choose completion from the user's requested deliverables and actual tool receipts. A draft, successful review or launch receipt alone does not prove delivery. Check external operation evidence before any retry; do not repeat failed or uncertain writes automatically. Report remaining blockers accurately. Preserve budget for assembling, verifying and saving the requested deliverables; stop delegating when the shared budget reserve is reached.`;
