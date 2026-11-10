export type UnifiedProxyOperation = 'chat/completions' | 'responses' | 'messages' | 'images/generations' | 'systemone';

export type UnifiedProxyProvider = {
  id: string;
  name: string;
  protocol: string;
  models: string[];
};

export class UnifiedProxyError extends Error {
  readonly status: 400 | 404;

  constructor(message: string, status: 400 | 404 = 400) {
    super(message);
    this.name = 'UnifiedProxyError';
    this.status = status;
  }
}

export function resolveUnifiedModel(model: unknown, operation: UnifiedProxyOperation, providers: readonly UnifiedProxyProvider[]) {
  if (typeof model !== 'string') throw new UnifiedProxyError('The model must use the <providerName>/<modelId> format.');
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) throw new UnifiedProxyError('The model must use the <providerName>/<modelId> format.');
  const providerName = model.slice(0, separator).trim();
  const modelId = model.slice(separator + 1).trim();
  if (!providerName || !modelId) throw new UnifiedProxyError('The model must use the <providerName>/<modelId> format.');

  const provider = providers.find((candidate) => candidate.name === providerName);
  if (!provider) throw new UnifiedProxyError('Model provider not found.', 404);
  if (!provider.models.includes(modelId)) throw new UnifiedProxyError('The selected model is not configured for this provider.');

  const supported = provider.protocol === 'typesafe/systemone'
    ? operation === 'systemone'
    : provider.protocol === 'anthropic/messages'
      ? operation === 'messages'
        : provider.protocol === 'codex/responses' || provider.protocol === 'openai/responses'
          ? operation === 'responses' || operation === 'images/generations'
          : provider.protocol === 'openai/chat'
            ? operation === 'chat/completions' || operation === 'images/generations'
            : false;
  if (!supported) throw new UnifiedProxyError(`Provider protocol ${provider.protocol} does not support ${operation}.`);
  return { providerId: provider.id, providerName, modelId };
}
