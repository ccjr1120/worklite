import { describe, expect, it } from 'vitest';
import { readNodeIdentity } from './node-identity';

describe('readNodeIdentity', () => {
  it('prefers the stored label and keeps a non-empty description', () => {
    expect(readNodeIdentity({ label: '选题调研', description: '把想法整理成可核查的问题。' }, 'Agent')).toEqual({
      label: '选题调研',
      description: '把想法整理成可核查的问题。',
    });
  });

  it('falls back to the node type name when the definition has no label', () => {
    expect(readNodeIdentity({ model: 'GLM/glm-5.3' }, 'Agent')).toEqual({ label: 'Agent' });
    expect(readNodeIdentity(null, 'Canvas Render')).toEqual({ label: 'Canvas Render' });
  });

  it('trims surrounding whitespace and drops a blank label or description', () => {
    expect(readNodeIdentity({ label: '  Agent  ', description: '   ' }, 'Agent')).toEqual({ label: 'Agent' });
    expect(readNodeIdentity({ label: '   ', description: '生成封面图' }, 'Agent')).toEqual({ label: 'Agent', description: '生成封面图' });
  });
});
