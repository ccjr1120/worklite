import type { NodeErrorPolicy } from '@worklite/contracts';

export type AgentNodeDefinition = {
  id: string;
  position: number;
  agentVersionId: string;
  inputTemplate?: string;
  errorPolicy: NodeErrorPolicy;
};

export type WorkflowDefinition = {
  schemaVersion: number;
  nodes: AgentNodeDefinition[];
};

export function sortNodes(nodes: AgentNodeDefinition[]): AgentNodeDefinition[] {
  return [...nodes].sort((left, right) => left.position - right.position);
}
