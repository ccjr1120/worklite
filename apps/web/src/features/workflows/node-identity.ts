// Mirrors the limits declared by @worklite/workflow-engine node configSchemas.
// The web app does not depend on the engine package, so keep these in sync.
export const WORKFLOW_NODE_LABEL_MAX_LENGTH = 40;
export const WORKFLOW_NODE_DESCRIPTION_MAX_LENGTH = 200;

export type WorkflowNodeIdentity = {
  label: string;
  description?: string;
};

/**
 * Reads the optional author-facing identity from a node config. A missing or
 * blank label falls back to the node type name, so legacy definitions keep
 * rendering exactly as before.
 */
export function readNodeIdentity(config: Record<string, unknown> | null | undefined, fallbackLabel: string): WorkflowNodeIdentity {
  const label = typeof config?.label === 'string' ? config.label.trim() : '';
  const description = typeof config?.description === 'string' ? config.description.trim() : '';
  return {
    label: label || fallbackLabel,
    ...(description ? { description } : {}),
  };
}
