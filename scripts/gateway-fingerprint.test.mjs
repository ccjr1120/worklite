import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayFingerprint } from './gateway-fingerprint.mjs';

const files = [
  { path: 'apps/portkey-gateway/src/index.ts', hash: 'gateway-source', mode: 0o644, symlink: false },
  { path: 'apps/api/src/main.ts', hash: 'api-source', mode: 0o644, symlink: false },
  { path: 'README.md', hash: 'readme', mode: 0o644, symlink: false },
  { path: 'package.json', hash: 'root-package', mode: 0o644, symlink: false },
];

test('gatewayFingerprint changes when Gateway code or runtime configuration changes', () => {
  const baseline = gatewayFingerprint(files, { SECRET_ENCRYPTION_KEY: 'secret-a', API_PORT: '23391' });
  assert.notEqual(gatewayFingerprint([{ ...files[0], hash: 'gateway-source-v2' }, ...files.slice(1)], { SECRET_ENCRYPTION_KEY: 'secret-a', API_PORT: '23391' }), baseline);
  assert.notEqual(gatewayFingerprint(files, { SECRET_ENCRYPTION_KEY: 'secret-b', API_PORT: '23391' }), baseline);
});

test('gatewayFingerprint ignores unrelated API files, root docs, and runtime ports', () => {
  const baseline = gatewayFingerprint(files, { SECRET_ENCRYPTION_KEY: 'secret-a', API_PORT: '23391' });
  const changedUnrelated = files.map((file) => file.path.startsWith('apps/portkey-gateway/') ? file : { ...file, hash: `${file.hash}-changed` });
  assert.equal(gatewayFingerprint(changedUnrelated, { SECRET_ENCRYPTION_KEY: 'secret-a', API_PORT: '29999' }), baseline);
});
