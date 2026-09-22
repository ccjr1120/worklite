/**
 * Portkey AI Gateway
 *
 * @module index
 */

import { Context, Hono } from 'hono';
import { prettyJSON } from 'hono/pretty-json';
import { HTTPException } from 'hono/http-exception';
import { compress } from 'hono/compress';
import { getRuntimeKey } from 'hono/adapter';
// import { env } from 'hono/adapter' // Have to set this up for multi-environment deployment

// Middlewares
import { requestValidator } from './middlewares/requestValidator';
import { hooks } from './middlewares/hooks';
import { memoryCache } from './middlewares/cache';

// Handlers
import { proxyHandler } from './handlers/proxyHandler';
import { chatCompletionsHandler } from './handlers/chatCompletionsHandler';
import { completionsHandler } from './handlers/completionsHandler';
import { embeddingsHandler } from './handlers/embeddingsHandler';
import { logHandler } from './middlewares/log';
import { imageGenerationsHandler } from './handlers/imageGenerationsHandler';
import { createSpeechHandler } from './handlers/createSpeechHandler';
import { createTranscriptionHandler } from './handlers/createTranscriptionHandler';
import { createTranslationHandler } from './handlers/createTranslationHandler';
import { modelsHandler } from './handlers/modelsHandler';
import { realTimeHandler } from './handlers/realtimeHandler';
import filesHandler from './handlers/filesHandler';
import batchesHandler from './handlers/batchesHandler';
import finetuneHandler from './handlers/finetuneHandler';
import { messagesHandler } from './handlers/messagesHandler';
import { imageEditsHandler } from './handlers/imageEditsHandler';
import { messagesCountTokensHandler } from './handlers/messagesCountTokensHandler';
import modelResponsesHandler from './handlers/modelResponsesHandler';
import { createProvider, deleteProvider, getProvider, listProviders, providerView, requestLog, requestLogs, requestStats, updateProvider } from './worklite/provider-registry';
import { codexAuthStatus, deleteCodexAccount, importCodexAccounts, refreshCodexAccount, startCodexLogin, startCodexOAuthCallbackServer, updateCodexAccount } from './worklite/codex-auth';
import { codexAccountUsages, codexRateLimits } from './worklite/codex-transport';
import { isSystemOneProtocol, systemOnePassthrough, systemOneTest } from './worklite/systemone-transport';

// utils
import { logger } from './apm';
// Config
import conf from '../conf.json';
import { createCacheBackendsRedis } from './shared/services/cache';

// Create a new Hono server instance
const app = new Hono();
const runtime = getRuntimeKey();

async function dispatchInternal(request: Request, c: Context): Promise<Response> {
  return runtime === 'workerd' ? app.fetch(request, c.env, c.executionCtx) : app.fetch(request, c.env);
}

if (runtime === 'node' && process.env.REDIS_CONNECTION_STRING) {
  createCacheBackendsRedis(process.env.REDIS_CONNECTION_STRING);
}
/**
 * Middleware that conditionally applies compression middleware based on the runtime.
 * Compression is automatically handled for lagon and workerd runtimes
 * This check if its not any of the 2 and then applies the compress middleware to avoid double compression.
 */
app.use('*', (c, next) => {
  const runtimesThatDontNeedCompression = ['lagon', 'workerd', 'node'];
  if (runtimesThatDontNeedCompression.includes(runtime)) {
    return next();
  }
  return compress()(c, next);
});

if (runtime === 'node') {
  app.use('*', async (c: Context, next) => {
    if (!c.req.url.includes('/realtime')) {
      return next();
    }

    await next();

    if (
      c.req.url.includes('/realtime') &&
      c.req.header('upgrade') === 'websocket' &&
      (c.res.status >= 400 || c.get('websocketError') === true)
    ) {
      const finalStatus = c.get('websocketError') === true ? 500 : c.res.status;
      const socket = c.env.incoming.socket;
      if (socket) {
        socket.write(`HTTP/1.1 ${finalStatus} ${c.res.statusText}\r\n\r\n`);
        socket.destroy();
      }
    }
  });
}

/**
 * GET route for the root path.
 * Returns a greeting message.
 */
app.get('/', (c) => c.text('AI Gateway says hey!'));

app.get('/worklite/providers', async (c) => c.json(await listProviders()));
app.get('/worklite/stats', (c) => {
  try {
    return c.json(requestStats({ from: c.req.query('from'), to: c.req.query('to') }));
  } catch (error) {
    return c.json({ message: error instanceof RangeError ? error.message : 'Gateway statistics are unavailable.' }, 400);
  }
});
app.get('/worklite/request-logs', (c) => {
  const statusClass = c.req.query('statusClass');
  try {
    return c.json(requestLogs({
      from: c.req.query('from'),
      to: c.req.query('to'),
      provider: c.req.query('provider'),
      model: c.req.query('model'),
      statusClass: statusClass === 'success' || statusClass === 'client_error' || statusClass === 'server_error' ? statusClass : undefined,
      workflowRunId: c.req.query('workflowRunId'),
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
      cursor: c.req.query('cursor'),
    }));
  } catch (error) {
    return c.json({ message: error instanceof RangeError ? error.message : 'Request logs are unavailable.' }, 400);
  }
});
app.get('/worklite/request-logs/:requestLogId', (c) => {
  const log = requestLog(c.req.param('requestLogId'));
  return log ? c.json(log) : c.json({ message: 'Request log not found.' }, 404);
});
app.get('/worklite/codex/auth/status', (c) => c.json(codexAuthStatus()));
app.get('/worklite/codex/rate-limits', async (c) => {
  try { return c.json(await codexRateLimits()); } catch (error) { return c.json({ message: error instanceof Error ? error.message : 'Codex rate limits are unavailable.' }, 502); }
});
app.get('/worklite/codex/accounts/usage', async (c) => {
  try { return c.json(await codexAccountUsages()); } catch (error) { return c.json({ message: error instanceof Error ? error.message : 'Codex account usage is unavailable.' }, 502); }
});
app.post('/worklite/codex/auth/login', (c) => c.json(startCodexLogin()));
app.post('/worklite/codex/accounts/import', async (c) => {
  try { return c.json(importCodexAccounts(await c.req.json())); } catch (error) { return c.json({ message: error instanceof Error ? error.message : 'Codex account import failed.' }, 400); }
});
app.patch('/worklite/codex/accounts/:accountId', async (c) => {
  const body = await c.req.json().catch(() => null) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== 'boolean') return c.json({ message: 'Enabled must be a boolean.' }, 400);
  try { return c.json(updateCodexAccount(c.req.param('accountId'), body.enabled)); } catch (error) { return c.json({ message: error instanceof Error ? error.message : 'Codex account update failed.' }, 404); }
});
app.post('/worklite/codex/accounts/:accountId/refresh', async (c) => {
  try { return c.json(await refreshCodexAccount(c.req.param('accountId'))); } catch (error) { return c.json({ message: error instanceof Error ? error.message : 'Codex token refresh failed.' }, 502); }
});
app.delete('/worklite/codex/accounts/:accountId', (c) => c.json(deleteCodexAccount(c.req.param('accountId'))));
app.get('/worklite/providers/:providerId', async (c) => {
  const provider = await getProvider(c.req.param('providerId'));
  return provider ? c.json(providerView(provider)) : c.json({ message: 'Model provider not found.' }, 404);
});
type ResponsesTestPayload = {
  output_text?: string;
  output?: Array<{ type?: string; content?: unknown; summary?: unknown }>;
};

const responseContentText = (content: unknown): string => {
  const parts = Array.isArray(content) ? content : content ? [content] : [];
  return parts.map((part) => (
    part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
      ? (part as { text: string }).text
      : ''
  )).join('');
};

const parseResponsesTestOutput = (payload: ResponsesTestPayload): string => {
  const sections: string[] = [];

  for (const item of payload.output ?? []) {
    if (item.type === 'reasoning') {
      const reasoning = [responseContentText(item.content), responseContentText(item.summary)]
        .filter((text) => text.length > 0)
        .join('\n');
      if (reasoning) sections.push(`Reasoning\n${reasoning}`);
    } else if (item.type === 'message' && Array.isArray(item.content)) {
      const response = item.content.map((part) => {
        if (!part || typeof part !== 'object') return '';
        const content = part as { type?: string; text?: unknown; refusal?: unknown };
        if (content.type === 'refusal') return typeof content.refusal === 'string' ? content.refusal : '';
        return typeof content.text === 'string' ? content.text : '';
      }).join('');
      if (response) sections.push(`Response\n${response}`);
    }
  }

  return sections.join('\n\n');
};

app.post('/worklite/providers/:providerId/test', async (c) => {
  const provider = await getProvider(c.req.param('providerId'));
  if (!provider) return c.json({ message: 'Model provider not found.' }, 404);
  const input = await c.req.json().catch(() => null) as { model?: unknown } | null;
  const model = typeof input?.model === 'string' ? input.model.trim() : '';
  if (!model) return c.json({ message: 'Select a model before testing this provider.' }, 400);
  if (!provider.models.includes(model)) return c.json({ message: 'The selected model is not configured for this provider.' }, 400);
  if (isSystemOneProtocol(provider)) {
    // The fixed chat prompt has no representation in this contract, so the test
    // sends one minimal typed question instead.
    const requestLogId = `glog_${crypto.randomUUID()}`;
    const result = await systemOneTest(provider, model, requestLogId);
    if (!result.ok) return c.json({ message: result.message, requestLogId, protocol: 'typesafe/systemone', testInput: result.input }, result.status as 400);
    return c.json({ connection: 'connected', protocol: 'typesafe/systemone', model, input: result.input, output: result.output, traceId: crypto.randomUUID() });
  }
  const adapter = provider.protocol === 'anthropic/messages'
    ? 'anthropic'
    : provider.protocol === 'codex/responses'
      ? 'codex'
      : provider.protocol === 'openai/chat' || provider.protocol === 'openai/responses'
        ? 'openai'
        : null;
  if (!adapter) return c.json({ message: 'Unsupported model provider protocol.' }, 400);
  const headers = new Headers({ 'content-type': 'application/json', 'x-portkey-config': JSON.stringify({ provider: adapter, api_key: provider.apiKey, custom_host: provider.baseURL, ...(Object.keys(provider.headers ?? {}).length > 0 ? { forward_headers: Object.keys(provider.headers ?? {}) } : {}) }) });
  for (const [name, value] of Object.entries(provider.headers ?? {})) headers.set(name, value);
  const requestLogId = `glog_${crypto.randomUUID()}`;
  headers.set('x-worklite-log-source', 'provider_test');
  headers.set('x-worklite-log-id', requestLogId);
  headers.set('x-worklite-stat-provider', provider.name);
  const prompt = '\u4f60\u597d';
  const isCodex = provider.protocol === 'codex/responses';
  const isMessages = provider.protocol === 'anthropic/messages';
  const isResponses = isCodex || provider.protocol === 'openai/responses';
  const path = isMessages ? '/v1/messages' : isResponses ? '/v1/responses' : '/v1/chat/completions';
  const body = isCodex
    ? { model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }], store: false, stream: true }
    : isMessages
      ? { model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }
    : isResponses
      ? { model, input: prompt, max_output_tokens: 1024 }
      : { model, messages: [{ role: 'user', content: prompt }], max_tokens: 32 };
  const upstream = await dispatchInternal(new Request(new URL(path, c.req.url), { method: 'POST', headers, body: JSON.stringify(body) }), c);
  if (!upstream.ok) return c.json({ message: 'Provider connection failed.', requestLogId }, upstream.status as 400);
  const raw = await upstream.text();
  let payload: { choices?: Array<{ message?: { content?: string } }>; content?: Array<{ type?: string; text?: string }>; output_text?: string; output?: Array<{ type?: string; content?: unknown; summary?: unknown }> } = {};
  try { payload = JSON.parse(raw); } catch {}
  const streamedResponse = [...raw.matchAll(/"delta":"((?:\\.|[^"\\])*)"/g)].map((match) => JSON.parse(`"${match[1]}"`)).join('');
  const response = provider.protocol === 'openai/responses'
    ? parseResponsesTestOutput(payload) || payload.output_text || streamedResponse
    : isCodex
      ? payload.output_text ?? streamedResponse
      : isMessages
        ? payload.content?.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('') ?? ''
        : payload.choices?.[0]?.message?.content ?? '';
  return c.json({ connection: 'connected', protocol: provider.protocol, model, prompt, response, traceId: crypto.randomUUID() });
});
app.post('/worklite/providers', async (c) => {
  try { return c.json(await createProvider(await c.req.json()), 201); } catch (error) { return c.json({ message: error instanceof Error ? error.message : 'Provider could not be created.' }, 400); }
});
app.patch('/worklite/providers/:providerId', async (c) => {
  try { return c.json(await updateProvider(c.req.param('providerId'), await c.req.json())); } catch (error) { return c.json({ message: error instanceof Error ? error.message : 'Provider could not be updated.' }, 400); }
});
app.delete('/worklite/providers/:providerId', async (c) => {
  try { await deleteProvider(c.req.param('providerId')); return c.body(null, 204); } catch (error) { return c.json({ message: error instanceof Error ? error.message : 'Provider could not be deleted.' }, 404); }
});
app.all('/worklite/proxy/*', async (c) => {
  const providerId = c.req.header('x-worklite-provider-id');
  const provider = providerId ? await getProvider(providerId) : undefined;
  if (!provider) return c.json({ error: { message: 'Model provider not found.' } }, 404);
  const operation = c.req.path.slice('/worklite/proxy/'.length);
  if (operation !== 'models' && operation !== 'chat/completions' && operation !== 'responses' && operation !== 'messages' && operation !== 'images/generations' && operation !== 'systemone') return c.json({ error: { message: 'Unsupported Gateway operation.' } }, 400);
  if (operation === 'systemone' || isSystemOneProtocol(provider)) {
    // System One is forwarded verbatim rather than routed through a Portkey
    // adapter, so both sides of this pairing must agree.
    if (operation !== 'systemone' || !isSystemOneProtocol(provider)) return c.json({ error: { message: `Provider protocol ${provider.protocol} does not support ${operation}.` } }, 400);
    const forwardedBody = await c.req.text();
    let requestedModel = 'Unknown';
    try {
      const parsed = JSON.parse(forwardedBody) as { model?: unknown };
      if (typeof parsed.model === 'string' && parsed.model.trim()) requestedModel = parsed.model.trim();
    } catch {
      // A malformed body is forwarded unchanged so the upstream owns validation.
    }
    const forwarded = new Request(new URL('/v1/systemone', c.req.url), { method: 'POST', headers: c.req.raw.headers, body: forwardedBody });
    return systemOnePassthrough(forwarded, provider, requestedModel);
  }
  const adapter = provider.protocol === 'anthropic/messages'
    ? 'anthropic'
    : provider.protocol === 'codex/responses'
      ? 'codex'
      : provider.protocol === 'openai/chat' || provider.protocol === 'openai/responses'
        ? 'openai'
        : null;
  if (!adapter) return c.json({ error: { message: 'Unsupported model provider protocol.' } }, 400);
  const config = { provider: adapter, api_key: provider.apiKey, custom_host: provider.baseURL, ...(Object.keys(provider.headers ?? {}).length > 0 ? { forward_headers: Object.keys(provider.headers ?? {}) } : {}) };
  const headers = new Headers(c.req.raw.headers);
  headers.delete('x-worklite-provider-id');
  headers.set('x-worklite-stat-provider', provider.name);
  headers.set('x-portkey-config', JSON.stringify(config));
  for (const [name, value] of Object.entries(provider.headers ?? {})) headers.set(name, value);
  const body = c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : await c.req.text();
  return dispatchInternal(new Request(new URL(`/v1/${operation}`, c.req.url), { method: c.req.method, headers, body }), c);
});

// Use prettyJSON middleware for all routes
app.use('*', prettyJSON());

// Use logger middleware for all routes
if (getRuntimeKey() === 'node') {
  app.use(logHandler());
}

// Support the /v1/models endpoint
app.get('/v1/models', modelsHandler);

// Use hooks middleware for all routes
app.use('*', hooks);

if (conf.cache === true) {
  app.use('*', memoryCache());
}

/**
 * Default route when no other route matches.
 * Returns a JSON response with a message and status code 404.
 */
app.notFound((c) => c.json({ message: 'Not Found', ok: false }, 404));

/**
 * Global error handler.
 * If error is instance of HTTPException, returns the custom response.
 * Otherwise, logs the error and returns a JSON response with status code 500.
 */
app.onError((err, c) => {
  logger.error('Global Error Handler: ', err.message, err.cause, err.stack);
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  c.status(500);
  return c.json({ status: 'failure', message: err.message });
});

if (runtime === 'node') startCodexOAuthCallbackServer();

/**
 * POST route for '/v1/messages' in anthropic format
 */
app.post('/v1/messages', requestValidator, messagesHandler);

app.post(
  '/v1/messages/count_tokens',
  requestValidator,
  messagesCountTokensHandler
);

/**
 * POST route for '/v1/chat/completions'.
 * Handles requests by passing them to the chatCompletionsHandler.
 */
app.post('/v1/chat/completions', requestValidator, chatCompletionsHandler);

/**
 * POST route for '/v1/completions'.
 * Handles requests by passing them to the completionsHandler.
 */
app.post('/v1/completions', requestValidator, completionsHandler);

/**
 * POST route for '/v1/embeddings'.
 * Handles requests by passing them to the embeddingsHandler.
 */
app.post('/v1/embeddings', requestValidator, embeddingsHandler);

/**
 * POST route for '/v1/images/generations'.
 * Handles requests by passing them to the imageGenerations handler.
 */
app.post('/v1/images/generations', requestValidator, imageGenerationsHandler);

/**
 * POST route for '/v1/images/edits'.
 * Handles requests by passing them to the imageGenerations handler.
 */
app.post('/v1/images/edits', requestValidator, imageEditsHandler);

/**
 * POST route for '/v1/audio/speech'.
 * Handles requests by passing them to the createSpeechHandler.
 */
app.post('/v1/audio/speech', requestValidator, createSpeechHandler);

/**
 * POST route for '/v1/audio/transcriptions'.
 * Handles requests by passing them to the createTranscriptionHandler.
 */
app.post(
  '/v1/audio/transcriptions',
  requestValidator,
  createTranscriptionHandler
);

/**
 * POST route for '/v1/audio/translations'.
 * Handles requests by passing them to the createTranslationHandler.
 */
app.post('/v1/audio/translations', requestValidator, createTranslationHandler);

// files
app.get('/v1/files', requestValidator, filesHandler('listFiles', 'GET'));
app.get('/v1/files/:id', requestValidator, filesHandler('retrieveFile', 'GET'));
app.get(
  '/v1/files/:id/content',
  requestValidator,
  filesHandler('retrieveFileContent', 'GET')
);
app.post('/v1/files', requestValidator, filesHandler('uploadFile', 'POST'));
app.delete(
  '/v1/files/:id',
  requestValidator,
  filesHandler('deleteFile', 'DELETE')
);

// batches
app.post(
  '/v1/batches',
  requestValidator,
  batchesHandler('createBatch', 'POST')
);
app.get(
  '/v1/batches/:id',
  requestValidator,
  batchesHandler('retrieveBatch', 'GET')
);
app.get(
  '/v1/batches/*/output',
  requestValidator,
  batchesHandler('getBatchOutput', 'GET')
);
app.post(
  '/v1/batches/:id/cancel',
  requestValidator,
  batchesHandler('cancelBatch', 'POST')
);
app.get('/v1/batches', requestValidator, batchesHandler('listBatches', 'GET'));

// responses
app.post(
  '/v1/responses',
  requestValidator,
  modelResponsesHandler('createModelResponse', 'POST')
);
app.get(
  '/v1/responses/:id',
  requestValidator,
  modelResponsesHandler('getModelResponse', 'GET')
);
app.delete(
  '/v1/responses/:id',
  requestValidator,
  modelResponsesHandler('deleteModelResponse', 'DELETE')
);
app.get(
  '/v1/responses/:id/input_items',
  requestValidator,
  modelResponsesHandler('listResponseInputItems', 'GET')
);

app.all(
  '/v1/fine_tuning/jobs/:jobId?/:cancel?',
  requestValidator,
  finetuneHandler
);

/**
 * POST route for '/v1/prompts/:id/completions'.
 * Handles portkey prompt completions route
 */
app.post('/v1/prompts/*', requestValidator, (c) => {
  if (c.req.url.endsWith('/v1/chat/completions')) {
    return chatCompletionsHandler(c);
  } else if (c.req.url.endsWith('/v1/completions')) {
    return completionsHandler(c);
  }
  c.status(500);
  return c.json({
    status: 'failure',
    message: 'prompt completions error: Something went wrong',
  });
});

// WebSocket route
if (runtime === 'workerd') {
  app.get('/v1/realtime', realTimeHandler);
}

/**
 * @deprecated
 * Support the /v1 proxy endpoint
 */
app.post('/v1/proxy/*', proxyHandler);

// Support the /v1 proxy endpoint after all defined endpoints so this does not interfere.
app.post('/v1/*', requestValidator, proxyHandler);

// Support the /v1 proxy endpoint after all defined endpoints so this does not interfere.
app.get('/v1/:path{(?!realtime).*}', requestValidator, proxyHandler);

app.delete('/v1/*', requestValidator, proxyHandler);

// Export the app
export default app;
