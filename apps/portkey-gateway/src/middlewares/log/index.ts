import { Context } from 'hono';
import { getRuntimeKey } from 'hono/adapter';
import { recordRequestStat } from '../../worklite/provider-registry';

let logId = 0;
const MAX_RESPONSE_LENGTH = 100000;

// Map to store all connected log clients
const logClients: Map<string | number, any> = new Map();

const addLogClient = (clientId: any, client: any) => {
  logClients.set(clientId, client);
};

const removeLogClient = (clientId: any) => {
  logClients.delete(clientId);
};

const broadcastLog = async (log: any) => {
  const message = {
    data: log,
    event: 'log',
    id: String(logId++),
  };

  const deadClients: any = [];

  // Run all sends in parallel
  await Promise.all(
    Array.from(logClients.entries()).map(async ([id, client]) => {
      try {
        await Promise.race([
          client.sendLog(message),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Send timeout')), 1000)
          ),
        ]);
      } catch (error: any) {
        console.error(`Failed to send log to client ${id}:`, error.message);
        deadClients.push(id);
      }
    })
  );

  // Remove dead clients after iteration
  deadClients.forEach((id: any) => {
    removeLogClient(id);
  });
};

async function processLog(c: Context, start: number) {
  const ms = Date.now() - start;
  if (!c.req.url.includes('/v1/')) return;

  const requestOptionsArray = c.get('requestOptions');
  if (!requestOptionsArray?.length) {
    return;
  }

  let responseBody: any = undefined;
  try {
    const response = requestOptionsArray[0].requestParams.stream
      ? { message: 'The response was a stream.' }
      : await c.res.clone().json();
    responseBody = response;

    const responseString = JSON.stringify(response);
    if (responseString.length > MAX_RESPONSE_LENGTH) {
      requestOptionsArray[0].response =
        responseString.substring(0, MAX_RESPONSE_LENGTH) + '...';
    } else {
      requestOptionsArray[0].response = response;
    }
  } catch (error) {
    console.error('Error processing log:', error);
  }

  const requestBody = requestOptionsArray[0].requestParams ?? requestOptionsArray[0].transformedRequest?.body ?? {};
  const requestedModel = typeof requestBody?.model === 'string' ? requestBody.model : 'Unknown';
  const explicitProvider = c.req.header('x-worklite-stat-provider') ?? '';
  const modelSeparator = requestedModel.indexOf('/');
  const provider = explicitProvider || (modelSeparator > 0 ? requestedModel.slice(0, modelSeparator) : 'Unknown');
  const model = modelSeparator > 0 ? requestedModel.slice(modelSeparator + 1) : requestedModel;
  const usage = responseBody && typeof responseBody === 'object' && responseBody.usage && typeof responseBody.usage === 'object' ? responseBody.usage : undefined;
  const tokenValue = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
  recordRequestStat({
    provider,
    model,
    endpoint: new URL(c.req.url).pathname,
    status: c.res.status,
    durationMs: ms,
    promptTokens: tokenValue(usage?.prompt_tokens ?? usage?.input_tokens),
    completionTokens: tokenValue(usage?.completion_tokens ?? usage?.output_tokens),
    totalTokens: tokenValue(usage?.total_tokens ?? usage?.totalTokens),
  });

  await broadcastLog(
    JSON.stringify({
      time: new Date().toLocaleString(),
      method: c.req.method,
      endpoint: new URL(c.req.url).pathname,
      status: c.res.status,
      duration: ms,
      requestOptions: requestOptionsArray,
    })
  );
}

export const logHandler = () => {
  return async (c: Context, next: any) => {
    c.set('addLogClient', addLogClient);
    c.set('removeLogClient', removeLogClient);

    const start = Date.now();

    await next();

    const runtime = getRuntimeKey();

    if (runtime == 'workerd') {
      c.executionCtx.waitUntil(processLog(c, start));
    } else if (['node', 'bun', 'deno'].includes(runtime)) {
      processLog(c, start).then().catch(console.error);
    }
  };
};
