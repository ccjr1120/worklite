import { describe, expect, it } from 'vitest';
import { normalizeDevelopmentAssignments, normalizeDynamicDevelopmentAssignments } from './graph';

describe('development assignment ownership', () => {
  const first = { title: 'One', scopeSummary: 'First scope', ownedPaths: ['apps/api/src', 'apps/api/src/modules'] };
  const second = { title: 'Two', scopeSummary: 'Second scope', ownedPaths: ['apps/api/src/modules'] };

  it('permits redundant paths within one assignment but rejects overlap between assignments', () => {
    expect(normalizeDynamicDevelopmentAssignments([first], ['developer'])).toHaveLength(1);
    expect(() => normalizeDynamicDevelopmentAssignments([first, second], ['developer', 'developer-2'])).toThrow('overlap');
    expect(normalizeDevelopmentAssignments([{ ...first, developerId: 'developer' }], ['developer'])).toHaveLength(1);
    expect(() => normalizeDevelopmentAssignments([{ ...first, developerId: 'developer' }, { ...second, developerId: 'developer-2' }], ['developer', 'developer-2'])).toThrow('overlap');
  });

  it('allows the same path in separate repositories', () => {
    expect(normalizeDynamicDevelopmentAssignments([
      { ...first, repositoryIds: ['one'] },
      { ...second, repositoryIds: ['two'] },
    ], ['developer', 'developer-2'])).toHaveLength(2);
  });
});
