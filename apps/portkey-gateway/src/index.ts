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
import { createProvider, deleteProvider, getProvider, listProviders, providerView, requestStats, updateProvider } from './worklite/provider-registry';
import { codexAuthStatus, logoutCodex, refreshCodexCredential, startCodexLogin, startCodexOAuthCallbackServer } from './worklite/codex-auth';
import { codexRateLimits } from './worklite/codex-transport';

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
  const requestedWindow = c.req.query('window');
  const window = requestedWindow === '7d' || requestedWindow === '30d' ? requestedWindow : '24h';
  return c.json(requestStats(window));
});
app.get('/worklite/codex/auth/status', (c) => c.json(codexAuthStatus()));
app.get('/worklite/codex/rate-limits', async (c) => {
  try { return c.json(await codexRateLimits()); } catch (error) { return c.json({ message: error instanceof Error ? error.message : 'Codex rate limits are unavailable.' }, 502); }
});
app.post('/worklite/codex/auth/login', (c) => c.json(startCodexLogin()));
app.post('/worklite/codex/auth/refresh', async (c) => {
  try { return c.json(await refreshCodexCredential()); } catch (error) { return c.json({ message: error instanceof Error ? error.message : 'Codex token refresh failed.' }, 502); }
});
app.post('/worklite/codex/auth/logout', (c) => { logoutCodex(); return c.json(codexAuthStatus()); });
app.get('/worklite/providers/:providerId', async (c) => {
  const provider = await getProvider(c.req.param('providerId'));
  return provider ? c.json(providerView(provider)) : c.json({ message: 'Model provider not found.' }, 404);
});
app.post('/worklite/providers/:providerId/test', async (c) => {
  const provider = await getProvider(c.req.param('providerId'));
  if (!provider) return c.json({ message: 'Model provider not found.' }, 404);
  const input = await c.req.json().catch(() => null) as { model?: unknown } | null;
  const model = typeof input?.model === 'string' ? input.model.trim() : '';
  if (!model) return c.json({ message: 'Select a model before testing this provider.' }, 400);
  if (!provider.models.includes(model)) return c.json({ message: 'The selected model is not configured for this provider.' }, 400);
  const adapter = provider.protocol === 'codex/responses' ? 'codex' : provider.protocol.startsWith('deepseek/') ? 'deepseek' : 'openai';
  const headers = new Headers({ 'content-type': 'application/json', 'x-portkey-config': JSON.stringify({ provider: adapter, api_key: provider.apiKey, custom_host: provider.baseURL, ...(Object.keys(provider.headers ?? {}).length > 0 ? { forward_headers: Object.keys(provider.headers ?? {}) } : {}) }) });
  for (const [name, value] of Object.entries(provider.headers ?? {})) headers.set(name, value);
  const prompt = '\u4f60\u597d';
  const isCodex = provider.protocol === 'codex/responses';
  const path = isCodex ? '/v1/responses' : '/v1/chat/completions';
  const body = isCodex
    ? { model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }], store: false, stream: true }
    : { model, messages: [{ role: 'user', content: prompt }], max_tokens: 32 };
  const upstream = await dispatchInternal(new Request(new URL(path, c.req.url), { method: 'POST', headers, body: JSON.stringify(body) }), c);
  if (!upstream.ok) return c.json({ message: 'Provider connection failed.' }, upstream.status as 400);
  const raw = await upstream.text();
  let payload: { choices?: Array<{ message?: { content?: string } }>; output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> } = {};
  try { payload = JSON.parse(raw); } catch {}
  const response = isCodex
    ? payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? '').join('') ?? [...raw.matchAll(/"delta":"((?:\\.|[^"\\])*)"/g)].map((match) => JSON.parse(`"${match[1]}"`)).join('')
    : payload.choices?.[0]?.message?.content ?? '';
  return c.json({ connection: 'connected', model, prompt, response, traceId: crypto.randomUUID() });
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
  if (operation !== 'models' && operation !== 'chat/completions' && operation !== 'responses') return c.json({ error: { message: 'Unsupported Gateway operation.' } }, 400);
  const adapter = provider.protocol === 'codex/responses' ? 'codex' : provider.protocol.startsWith('deepseek/') ? 'deepseek' : 'openai';
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
