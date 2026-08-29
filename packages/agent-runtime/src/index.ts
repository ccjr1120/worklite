export type AgentRuntimeSettings = {
  agentVersionId: string;
  model: string;
  systemPrompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  outputFormat?: string;
};

export type AgentExecutionContext = {
  workflowRunId?: string;
  workflowVersionId?: string;
  nodeId?: string;
  variables: Readonly<Record<string, unknown>>;
};

export type AgentExecutionRequest = {
  input: unknown;
  settings: AgentRuntimeSettings;
  context: AgentExecutionContext;
  signal: AbortSignal;
};

export type AgentExecutionResult = {
  output: unknown;
  artifacts?: Array<{ id: string; type: string; name?: string }>;
};

export type AgentExecutor = (request: AgentExecutionRequest) => Promise<AgentExecutionResult>;
