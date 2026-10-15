import type { AgentExecutionErrorCode, AgentExecutionPhase } from '@worklite/contracts';
import { ModelGatewayError } from '@worklite/model-gateway';

export class TooManyToolCallsError extends Error {
  constructor() {
    super('The model requested too many tools in one step.');
    this.name = 'TooManyToolCallsError';
  }
}

export class InvalidAgentToolRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAgentToolRequestError';
  }
}

export type ExecutionFailure = { message: string; code: AgentExecutionErrorCode; phase: AgentExecutionPhase };

export function executionFailure(error: unknown): ExecutionFailure {
  if (error instanceof ModelGatewayError) {
    if (error.code === 'INCOMPLETE_TOOL_REQUEST') return { message: error.message, code: 'incomplete_tool_request', phase: 'model' };
    if (error.code === 'INVALID_TOOL_REQUEST') return { message: error.message, code: 'invalid_tool_request', phase: 'model' };
    if (error.code === 'INVALID_PROVIDER') return { message: 'The Agent provider configuration is invalid. Check the provider settings and try again.', code: 'provider', phase: 'model' };
    if (error.code === 'PROVIDER_REQUEST_FAILED') return { message: error.message, code: 'provider_request', phase: 'model' };
    if (error.code === 'INVALID_REQUEST') return { message: error.message, code: 'invalid_request', phase: 'model' };
  }
  if (error instanceof Error && error.name === 'AI_MissingToolResultsError') return { message: 'The Agent conversation was missing a tool result. Retry repairs the recorded tool exchange before contacting the model.', code: 'missing_tool_results', phase: 'model' };
  if (error instanceof TooManyToolCallsError) return { message: 'The model requested too many tools in one step. Retry so the Agent can continue with fewer tool calls.', code: 'too_many_tool_calls', phase: 'model' };
  if (error instanceof InvalidAgentToolRequestError) return { message: error.message, code: 'invalid_tool_request', phase: 'model' };
  if (error instanceof Error && error.message === 'Skill execution failed') return { message: 'The Agent Skill script could not be completed.', code: 'skill', phase: 'skill' };
  return { message: 'The Agent could not complete this turn because an internal execution error occurred. Retry the request.', code: 'internal', phase: 'model' };
}

export function executionFailureSource(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_.-]+$/.test(error.name) ? error.name : typeof error;
}
