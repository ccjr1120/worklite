import { Context, Next } from 'hono';
import { HEADER_KEYS } from '../globals';
import { env } from 'hono/adapter';
import { codexModels } from '../worklite/codex-transport';

/**
 * Handles the models request. Returns a list of models supported by the Ai gateway.
 * Allows filters in query params for the provider
 * @param c - The Hono context
 * @returns - The response
 */
export const modelsHandler = async (context: Context, next: Next) => {
  const fetchOptions: RequestInit = { method: context.req.method };
  const controlPlaneURL = env(context).ALBUS_BASEPATH;
  const headers = Object.fromEntries(context.req.raw.headers);
  const authHeader = headers.authorization;
  let config: any = headers[HEADER_KEYS.CONFIG];
  if (config && typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch {
      config = {};
    }
  }
  const apiKey = headers[HEADER_KEYS.API_KEY] || authHeader?.replace(/^Bearer\s+/i, '') || config?.api_key;
  const providerHeader = headers[HEADER_KEYS.PROVIDER];
  const virtualKey = headers[HEADER_KEYS.VIRTUAL_KEY];

  const containsProvider = providerHeader || virtualKey || config?.provider || config?.virtual_key;

  if (config?.provider === 'codex') return codexModels(context.req.raw);

  if (containsProvider && config?.custom_host) {
    let target: URL;
    try {
      target = new URL(config.custom_host);
      if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) throw new Error('Unsupported URL');
      target.pathname = `${target.pathname.replace(/\/+$/, '')}/models`;
      target.hash = '';
    } catch {
      return new Response(JSON.stringify({ error: { message: 'Provider Base URL is invalid.' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }

    const forwardedHeaders: Record<string, string> = {};
    const configuredForwardHeaders = Array.isArray(config.forward_headers) ? config.forward_headers : [];
    for (const name of configuredForwardHeaders) {
      const value = headers[name.toLowerCase()];
      if (value) forwardedHeaders[name.toLowerCase()] = value;
    }
    if (apiKey) forwardedHeaders.authorization = `Bearer ${apiKey}`;
    fetchOptions.headers = forwardedHeaders;
    try {
      const response = await fetch(target, fetchOptions);
      return new Response(response.body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } });
    } catch {
      return new Response(JSON.stringify({ error: { message: 'Provider model discovery failed.' } }), { status: 502, headers: { 'content-type': 'application/json' } });
    }
  }

  if (containsProvider || !controlPlaneURL) {
    return next();
  }

  // Strip gateway endpoint for models endpoint.
  const urlObject = new URL(context.req.url);
  const requestRoute = `${controlPlaneURL}${context.req.path.replace('/v1/', '/v2/')}${urlObject.search}`;
  fetchOptions['headers'] = {
    [HEADER_KEYS.API_KEY]: apiKey,
  };

  const resp = await fetch(requestRoute, fetchOptions);
  return new Response(resp.body, {
    status: resp.status,
    headers: {
      'content-type': 'application/json',
    },
  });
};
