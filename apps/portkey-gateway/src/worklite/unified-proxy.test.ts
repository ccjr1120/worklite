import { resolveUnifiedModel, UnifiedProxyError, type UnifiedProxyProvider } from './unified-proxy';

const providers: UnifiedProxyProvider[] = [
  { id: 'p_codex', name: 'codex', protocol: 'codex/responses', models: ['gpt-test', 'gpt-image-2'] },
  { id: 'p_anthropic', name: 'anthropic-main', protocol: 'anthropic/messages', models: ['claude-sonnet-4-5'] },
  { id: 'p_openai', name: 'openai', protocol: 'openai/responses', models: ['gpt-5.1'] },
  { id: 'p_systemone', name: 'typesafe', protocol: 'typesafe/systemone', models: ['system-one-v2'] },
];

describe('resolveUnifiedModel', () => {
  it('resolves the provider prefix and preserves model ids containing slashes', () => {
    expect(resolveUnifiedModel('anthropic-main/vendor/claude-sonnet-4-5', 'messages', [
      { ...providers[1], models: ['vendor/claude-sonnet-4-5'] },
    ])).toEqual({ providerId: 'p_anthropic', providerName: 'anthropic-main', modelId: 'vendor/claude-sonnet-4-5' });
  });

  it('supports OpenAI image generation and routes System One only through its own operation', () => {
    expect(resolveUnifiedModel('openai/gpt-5.1', 'images/generations', providers).providerId).toBe('p_openai');
    expect(resolveUnifiedModel('typesafe/system-one-v2', 'systemone', providers).providerId).toBe('p_systemone');
    expect(() => resolveUnifiedModel('typesafe/system-one-v2', 'responses', providers)).toThrow(UnifiedProxyError);
  });

  it('rejects malformed, unknown, unconfigured, and protocol-mismatched models', () => {
    expect(() => resolveUnifiedModel('bad-model', 'responses', providers)).toThrow('providerName>/<modelId>');
    expect(() => resolveUnifiedModel('missing/model', 'responses', providers)).toThrow('Model provider not found');
    expect(() => resolveUnifiedModel('openai/not-configured', 'responses', providers)).toThrow('not configured');
    expect(() => resolveUnifiedModel('anthropic-main/claude-sonnet-4-5', 'responses', providers)).toThrow('does not support');
  });
  it('routes Codex Responses and image generation alongside the other protocols', () => {
    expect(resolveUnifiedModel('codex/gpt-test', 'responses', providers).providerId).toBe('p_codex');
    expect(resolveUnifiedModel('codex/gpt-image-2', 'images/generations', providers).providerId).toBe('p_codex');
    expect(() => resolveUnifiedModel('codex/gpt-test', 'messages', providers)).toThrow('does not support');
  });

});
