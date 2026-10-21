import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveUnifiedModel, UnifiedProxyError } from '../apps/portkey-gateway/src/worklite/unified-proxy.ts';

const providers = [
  { id: 'p_anthropic', name: 'anthropic-main', protocol: 'anthropic/messages', models: ['claude-sonnet-4-5'] },
  { id: 'p_codex', name: 'codex', protocol: 'codex/responses', models: ['gpt-5.1'] },
  { id: 'p_systemone', name: 'typesafe', protocol: 'typesafe/systemone', models: ['system-one-v2'] },
];

test('resolves a provider prefix and preserves model ids containing slashes', () => {
  assert.deepEqual(resolveUnifiedModel('anthropic-main/vendor/claude-sonnet-4-5', 'messages', [
    { ...providers[0], models: ['vendor/claude-sonnet-4-5'] },
  ]), { providerId: 'p_anthropic', providerName: 'anthropic-main', modelId: 'vendor/claude-sonnet-4-5' });
});

test('routes Codex images and limits System One to its dedicated operation', () => {
  assert.equal(resolveUnifiedModel('codex/gpt-5.1', 'images/generations', providers).providerId, 'p_codex');
  assert.equal(resolveUnifiedModel('typesafe/system-one-v2', 'systemone', providers).providerId, 'p_systemone');
  assert.throws(() => resolveUnifiedModel('typesafe/system-one-v2', 'responses', providers), UnifiedProxyError);
});

test('rejects malformed, unknown, unconfigured, and protocol-mismatched models', () => {
  assert.throws(() => resolveUnifiedModel('bad-model', 'responses', providers), /providerName/);
  assert.throws(() => resolveUnifiedModel('missing/model', 'responses', providers), /Model provider not found/);
  assert.throws(() => resolveUnifiedModel('codex/not-configured', 'responses', providers), /not configured/);
  assert.throws(() => resolveUnifiedModel('anthropic-main/claude-sonnet-4-5', 'responses', providers), /does not support/);
});
