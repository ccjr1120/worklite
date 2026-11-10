import { describe, expect, it } from 'vitest';
import { validateAgentCapabilities } from './agent-capability-validation';

const capability = { id: 'render/map', type: 'worklite/artifact', typeVersion: '1', config: {} };
const source = 'wechat-article/AGENT.md';

describe('Agent capability validation', () => {
  it('allows slash ids, repeated types and the same ids in separate Agents', () => {
    const capabilities = [capability, { ...capability, id: 'second' }, { ...capability, id: 'third' }];
    expect(() => validateAgentCapabilities(capabilities, source)).not.toThrow();
    expect(() => validateAgentCapabilities(capabilities, 'another/AGENT.md')).not.toThrow();
  });

  it('identifies both entries of an exact duplicate id', () => {
    expect(() => validateAgentCapabilities([capability, { ...capability, type: 'worklite/image' }], source))
      .toThrow('Duplicate Agent capability id "render/map" in wechat-article/AGENT.md: capabilities[1].id repeats capabilities[0].id.');
  });

  it.each([
    [null, 'must be an array'],
    [[null], 'capabilities[0] must be an object'],
    [[{ ...capability, id: ' ' }], 'capabilities[0].id must be a non-empty string'],
    [[{ ...capability, config: null }], 'config must be an object'],
    [[{ ...capability, config: [] }], 'config must be an object'],
    [[{ ...capability, typeVersion: '999' }], 'Unsupported Agent capability worklite/artifact@999'],
  ])('reports the failed rule for %j', (value, message) => {
    expect(() => validateAgentCapabilities(value, source)).toThrow(message);
    expect(() => validateAgentCapabilities(value, source)).toThrow(source);
  });

  it('identifies forbidden workflow controls separately', () => {
    expect(() => validateAgentCapabilities([{ ...capability, type: 'worklite/map' }], source, ['worklite/map']))
      .toThrow('worklite/map is a workflow control');
  });
});
