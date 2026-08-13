export type AgentRuntimeSettings = {
  agentVersionId: string;
  model: string;
  systemPrompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  outputFormat?: string;
};

export type AgentExecutionInput = {
  workflowInput: unknown;
  previousNodeOutput: unknown;
  workflowVariables: Record<string, unknown>;
};

export type AgentExecutionResult = {
  output: unknown;
};
