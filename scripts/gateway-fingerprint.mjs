import { createHash } from 'node:crypto';

const GATEWAY_ENV_KEYS = [
  'NODE_ENV', 'ENVIRONMENT', 'TLS_KEY_PATH', 'TLS_CERT_PATH', 'TLS_CA_PATH',
  'AI21_API_KEY', 'ANTHROPIC_API_KEY', 'ANYSCALE_API_KEY', 'AZURE_OPENAI_API_KEY', 'BEDROCK_API_KEY',
  'COHERE_API_KEY', 'DEEPINFRA_API_KEY', 'FIREWORKS_AI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY',
  'JINA_API_KEY', 'LINGYI_API_KEY', 'MISTRAL_API_KEY', 'MONSTERAPI_API_KEY', 'MOONSHOT_API_KEY',
  'NOMIC_API_KEY', 'NOVITA_API_KEY', 'NSCALE_API_KEY', 'OLLAMA_API_KEY', 'OPENAI_API_KEY',
  'OPENROUTER_API_KEY', 'PALM_API_KEY', 'PERPLEXITY_API_KEY', 'PREDIBASE_API_KEY', 'REKA_API_KEY',
  'SEGMIND_API_KEY', 'STABILITY_API_KEY', 'TOGETHER_AI_API_KEY', 'VERTEX_AI_API_KEY',
  'WORKERS_AI_API_KEY', 'ZHIPU_API_KEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_ROLE_ARN', 'AWS_PROFILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_ASSUME_ROLE_ACCESS_KEY_ID',
  'AWS_ASSUME_ROLE_SECRET_ACCESS_KEY', 'AWS_ASSUME_ROLE_REGION', 'AWS_REGION', 'AWS_ENDPOINT_DOMAIN', 'AWS_IMDS_V1',
  'AZURE_AUTH_MODE', 'AZURE_ENTRA_CLIENT_ID', 'AZURE_ENTRA_CLIENT_SECRET', 'AZURE_ENTRA_TENANT_ID',
  'AZURE_MANAGED_CLIENT_ID', 'AZURE_MANAGED_VERSION', 'IDENTITY_ENDPOINT', 'IDENTITY_HEADER',
  'AZURE_AUTHORITY_HOST', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_FEDERATED_TOKEN_FILE',
  'SSE_ENCRYPTION_TYPE', 'KMS_KEY_ID', 'KMS_BUCKET_KEY_ENABLED', 'KMS_ENCRYPTION_CONTEXT',
  'KMS_ENCRYPTION_ALGORITHM', 'KMS_ENCRYPTION_CUSTOMER_KEY', 'KMS_ENCRYPTION_CUSTOMER_KEY_MD5', 'KMS_ROLE_ARN',
  'HTTP_PROXY', 'HTTPS_PROXY', 'APM_LOGGER', 'TRUSTED_CUSTOM_HOSTS', 'PORTKEY_TRUSTED_CUSTOM_HOSTS',
  'REDIS_CONNECTION_STRING', 'SECRET_ENCRYPTION_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_ACCOUNT_ID',
  'CODEX_UPSTREAM_URL', 'CODEX_CLIENT_VERSION', 'CODEX_USER_AGENT', 'CODEX_ORIGINATOR', 'CODEX_RESIDENCY',
  'CODEX_OAUTH_CALLBACK_ENABLED',
];

const GATEWAY_FILE = (path) => path.startsWith('apps/portkey-gateway/src/')
  || path.startsWith('apps/portkey-gateway/patches/')
  || path === 'apps/portkey-gateway/package.json'
  || path === 'apps/portkey-gateway/rollup.config.js'
  || path === 'apps/portkey-gateway/tsconfig.json'
  || path === 'apps/portkey-gateway/conf.json'
  || path === 'apps/portkey-gateway/conf.example.json'
  || path === 'apps/api/portkey-local-bind.cjs'
  || path === 'scripts/managed-gateway.mjs'
  || path === 'pnpm-lock.yaml'
  || path === 'pnpm-workspace.yaml';

export function gatewayFingerprint(files, environment = process.env) {
  const source = files
    .filter((file) => GATEWAY_FILE(file.path))
    .map(({ path, hash, mode, symlink }) => ({ path, hash, mode, symlink }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const configuration = Object.fromEntries(GATEWAY_ENV_KEYS.map((key) => [key, environment[key] ?? null]));
  return createHash('sha256').update(JSON.stringify({ source, configuration })).digest('hex');
}

