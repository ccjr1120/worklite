import { describe, expect, it } from 'vitest';
import {
  createGenericAgentNodeType,
  listWorkflowNodeCapabilities,
  resolveWorkflowNodeCapability,
  WORKFLOW_NODE_DESCRIPTION_MAX_LENGTH,
  WORKFLOW_NODE_LABEL_MAX_LENGTH,
  type JsonSchema,
} from './index';

const labelSchema = { type: 'string', minLength: 1, maxLength: WORKFLOW_NODE_LABEL_MAX_LENGTH };
const descriptionSchema = { type: 'string', minLength: 1, maxLength: WORKFLOW_NODE_DESCRIPTION_MAX_LENGTH };

function configProperties(capability: { configSchema: JsonSchema }): Record<string, unknown> {
  return capability.configSchema.properties as Record<string, unknown>;
}

describe('workflow node identity schema', () => {
  const capabilities = [
    ...listWorkflowNodeCapabilities(),
    createGenericAgentNodeType(async () => ({ output: null })),
  ];

  it('declares optional label and description for every node type', () => {
    expect(capabilities.length).toBeGreaterThan(0);
    for (const capability of capabilities) {
      expect(configProperties(capability).label, capability.id).toEqual(labelSchema);
      expect(configProperties(capability).description, capability.id).toEqual(descriptionSchema);
    }
  });

  it('keeps label and description optional so legacy node configs stay valid', () => {
    for (const capability of capabilities) {
      const required = capability.configSchema.required;
      expect(Array.isArray(required) ? required : [], capability.id).not.toContain('label');
      expect(Array.isArray(required) ? required : [], capability.id).not.toContain('description');
    }
  });

  it('exposes the identity fields through resolveWorkflowNodeCapability', () => {
    const capability = resolveWorkflowNodeCapability('worklite/agent', '1');
    expect(capability).toBeDefined();
    expect(configProperties(capability!).label).toEqual(labelSchema);
    expect(configProperties(capability!).description).toEqual(descriptionSchema);
  });
});
