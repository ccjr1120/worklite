import { Context } from 'hono';
import { getRuntimeKey } from 'hono/adapter';
import { recordRequestLog, recordRequestStat, type GatewayRequestLogResponse } from '../../worklite/provider-registry';
import { normalizeTokenUsage, usageFromStreamEvents } from '../../worklite/token-usage';

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

function parseStreamCapture(raw: string): unknown[] {
  const events: unknown[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      events.push(payload);
    }
  }
  return events;
}

async function captureResponse(c: Context, streaming: boolean): Promise<{ capture: GatewayRequestLogResponse; usage?: Record<string, unknown> }> {
  try {
    const clone = c.res.clone();
    if (streaming) {
      const raw = await clone.text();
      const events = parseStreamCapture(raw);
      if (events.length === 0) return { capture: { kind: 'text', body: raw } };
      return { capture: { kind: 'stream', events }, usage: usageFromStreamEvents(events) };
    }
    const raw = await clone.text();
    try {
      const body = JSON.parse(raw);
      const usage = body && typeof body === 'object' && !Array.isArray(body) && (body as Record<string, unknown>).usage;
      return { capture: { kind: 'json', body }, usage: usage && typeof usage === 'object' && !Array.isArray(usage) ? usage as Record<string, unknown> : undefined };
    } catch {
      return { capture: { kind: 'text', body: raw } };
    }
  } catch (error) {
    return { capture: { kind: 'unavailable', reason: error instanceof Error ? error.message : 'The response could not be captured.' } };
  }
}

async function processLog(c: Context, start: number) {
  const ms = Date.now() - start;
  if (!c.req.url.includes('/v1/')) return;

  const requestOptionsArray = c.get('requestOptions');
  if (!requestOptionsArray?.length) {
    return;
  }

  const streaming = Boolean(requestOptionsArray[0].requestParams?.stream);
  const captured = await captureResponse(c, streaming);
  let responseBody: any = undefined;
  try {
    const response = streaming
      ? { message: 'The response was a stream.' }
      : captured.capture.kind === 'json'
        ? captured.capture.body
        : { message: 'The response was not JSON.' };
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
  const usage = captured.usage
    ?? (responseBody && typeof responseBody === 'object' && responseBody.usage && typeof responseBody.usage === 'object' ? responseBody.usage : undefined);
  const endpoint = new URL(c.req.url).pathname;
  const tokenUsage = normalizeTokenUsage(usage, endpoint);
  recordRequestStat({
    provider,
    model,
    endpoint,
    status: c.res.status,
    durationMs: ms,
    ...tokenUsage,
  });

  const correlationHeader = (name: string): string | null => {
    const value = c.req.header(name);
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  try {
    recordRequestLog({
      id: correlationHeader('x-worklite-log-id'),
      provider,
      model,
      endpoint,
      status: c.res.status,
      durationMs: ms,
      streaming,
      source: correlationHeader('x-worklite-log-source'),
      workflowRunId: correlationHeader('x-worklite-workflow-run-id'),
      nodeRunId: correlationHeader('x-worklite-node-run-id'),
      teamRunId: correlationHeader('x-worklite-team-run-id'),
      teamTaskAttemptId: correlationHeader('x-worklite-team-task-attempt-id'),
      teamOperationKey: correlationHeader('x-worklite-team-operation-key'),
      ...tokenUsage,
      request: requestOptionsArray[0].transformedRequest?.body ?? requestOptionsArray[0].requestParams ?? null,
      response: captured.capture,
    });
  } catch (error) {
    console.error('Error recording request log:', error);
  }

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
