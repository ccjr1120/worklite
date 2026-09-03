#!/usr/bin/env node

import { createRequire } from 'node:module';

const DEFAULT_PROVIDER_URL = 'https://app-hk.ppapi.ai/v1';
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:4547/v1';
const DEFAULT_MODEL = 'gpt-5.6-sol';
const DEFAULT_PROMPT = 'Hello';
const DEFAULT_TIMEOUT_MS = 35_000;

const options = parseOptions(process.argv.slice(2));
const providerUrl = trimTrailingSlash(process.env.RESPONSES_PROVIDER_URL ?? DEFAULT_PROVIDER_URL);
const gatewayUrl = trimTrailingSlash(process.env.RESPONSES_GATEWAY_URL ?? DEFAULT_GATEWAY_URL);
const model = process.env.RESPONSES_MODEL ?? DEFAULT_MODEL;
const prompt = process.env.RESPONSES_PROMPT ?? DEFAULT_PROMPT;
const apiKey = process.env.RESPONSES_API_KEY;
const timeoutMs = parsePositiveInteger(process.env.RESPONSES_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
const hasCustomPortkeyConfig = Boolean(process.env.RESPONSES_PORTKEY_CONFIG);
const requireWorkspaceDependency = createRequire(new URL('../packages/model-gateway/package.json', import.meta.url));

if (options.help) {
  printHelp();
  process.exit(0);
}

if (!apiKey && !options.skipProvider) {
  console.error('Set RESPONSES_API_KEY for the direct provider check, or pass --skip-provider.');
  console.error('Use --help to see all options.');
  process.exit(2);
}

if (!apiKey && !hasCustomPortkeyConfig && (!options.skipGateway || !options.skipSdk)) {
  console.error('Set RESPONSES_API_KEY or RESPONSES_PORTKEY_CONFIG for Gateway/SDK checks.');
  console.error('Use --help to see all options.');
  process.exit(2);
}

const portkeyConfig = process.env.RESPONSES_PORTKEY_CONFIG ?? JSON.stringify({
  provider: 'openai',
  api_key: apiKey ?? '',
  custom_host: providerUrl,
});

console.log(`Model: ${model}`);
console.log(`Prompt: ${prompt}`);
console.log(`Provider URL: ${providerUrl}`);
console.log(`Gateway URL: ${gatewayUrl}`);
console.log(`Timeout: ${timeoutMs} ms`);
console.log('');

const results = [];

if (!options.skipProvider) {
  results.push(await checkEndpoint('provider', providerUrl, {
    Authorization: `Bearer ${apiKey}`,
  }));
}

if (!options.skipGateway) {
  results.push(await checkEndpoint('gateway', gatewayUrl, {
    'x-portkey-config': portkeyConfig,
    'x-portkey-trace-id': `diagnose-${Date.now()}`,
  }));
}

if (!options.skipSdk) {
  results.push(await checkSdk(gatewayUrl, portkeyConfig));
}

const failed = results.filter((result) => !result.ok);
console.log('');
console.log(failed.length === 0 ? 'Diagnostic completed without detected failures.' : `${failed.length} check(s) failed.`);
process.exitCode = failed.length === 0 ? 0 : 1;

async function checkEndpoint(label, baseUrl, headers) {
  console.log(`== ${label} ==`);
  const nonStreaming = await requestJson(`${baseUrl}/responses`, headers, false);
  printJsonResult('non-stream', nonStreaming);

  const streaming = await requestStream(`${baseUrl}/responses`, headers);
  printStreamResult('stream', streaming);

  return {
    ok: nonStreaming.ok && streaming.ok,
    label,
    nonStreaming,
    streaming,
  };
}

async function requestJson(url, headers, stream) {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: prompt, stream }),
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return {
      ok: response.ok && body !== null,
      status: response.status,
      contentType: response.headers.get('content-type'),
      elapsedMs: Date.now() - startedAt,
      body,
      text,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      contentType: null,
      elapsedMs: Date.now() - startedAt,
      body: null,
      text: '',
      error: formatError(error),
    };
  }
}

async function requestStream(url, headers) {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ model, input: prompt, stream: true }),
    });
    if (!response.body) {
      return {
        ok: false,
        status: response.status,
        contentType: response.headers.get('content-type'),
        elapsedMs: Date.now() - startedAt,
        raw: '',
        events: [],
        error: 'Response body is empty',
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    const events = parseSse(raw);
    const eventTypes = events.map((event) => event.type).filter(Boolean);
    const hasAccepted = eventTypes.includes('response.in_progress');
    const hasTextDelta = eventTypes.includes('response.output_text.delta');
    const hasTerminal = eventTypes.some((type) => ['response.completed', 'response.incomplete', 'response.failed'].includes(type));
    const parseErrors = events.filter((event) => event.error).map((event) => event.error);
    const ok = response.ok && events.length > 0 && hasTerminal && parseErrors.length === 0;

    return {
      ok,
      status: response.status,
      contentType: response.headers.get('content-type'),
      elapsedMs: Date.now() - startedAt,
      raw,
      events,
      eventTypes,
      hasAccepted,
      hasTextDelta,
      hasTerminal,
      parseErrors,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      contentType: null,
      elapsedMs: Date.now() - startedAt,
      raw: '',
      events: [],
      error: formatError(error),
    };
  }
}

async function checkSdk(baseUrl, config) {
  console.log('== ai-sdk ==');
  const startedAt = Date.now();
  let sdkResult;
  try {
    const { createOpenAI } = requireWorkspaceDependency('@ai-sdk/openai');
    const { streamText } = requireWorkspaceDependency('ai');
    const openai = createOpenAI({
      apiKey: 'diagnostic',
      baseURL: baseUrl,
      headers: { 'x-portkey-config': config },
    });
    sdkResult = streamText({
      model: openai.responses(model),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      maxOutputTokens: 256,
      onError: () => {},
    });
    for (const promise of [sdkResult.text, sdkResult.usage, sdkResult.finishReason, sdkResult.response]) {
      promise?.catch(() => {});
    }
    let text = '';
    for await (const delta of sdkResult.textStream) text += delta;
    const [finishReason] = await Promise.all([sdkResult.finishReason]);
    const response = {
      ok: text.trim().length > 0,
      elapsedMs: Date.now() - startedAt,
      textLength: text.length,
      finishReason,
      error: null,
    };
    console.log(`  status=ok elapsed=${response.elapsedMs}ms textLength=${response.textLength} finishReason=${finishReason}`);
    return { ...response, label: 'ai-sdk' };
  } catch (error) {
    if (sdkResult) {
      await Promise.allSettled([
        sdkResult.text,
        sdkResult.usage,
        sdkResult.finishReason,
        sdkResult.response,
      ]);
    }
    const response = {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      textLength: 0,
      finishReason: null,
      error: formatError(error),
    };
    console.log(`  status=failed elapsed=${response.elapsedMs}ms error=${response.error}`);
    return { ...response, label: 'ai-sdk' };
  }
}

function printJsonResult(label, result) {
  const keys = result.body && typeof result.body === 'object' ? Object.keys(result.body).join(',') : '-';
  const responseStatus = result.body?.status ?? '-';
  const outputTextLength = typeof result.body?.output_text === 'string' ? result.body.output_text.length : '-';
  console.log(`  ${label}: status=${result.status ?? '-'} elapsed=${result.elapsedMs}ms contentType=${result.contentType ?? '-'} bodyKeys=${keys} responseStatus=${responseStatus} outputTextLength=${outputTextLength}`);
  if (!result.ok) console.log(`    error=${result.error ?? 'Invalid JSON response'}`);
}

function printStreamResult(label, result) {
  const counts = countValues(result.eventTypes ?? []);
  console.log(`  ${label}: status=${result.status ?? '-'} elapsed=${result.elapsedMs}ms contentType=${result.contentType ?? '-'} bytes=${Buffer.byteLength(result.raw ?? '', 'utf8')}`);
  console.log(`    accepted=${result.hasAccepted ? 'yes' : 'no'} textDelta=${result.hasTextDelta ? 'yes' : 'no'} terminal=${result.hasTerminal ? 'yes' : 'no'}`);
  console.log(`    events=${Object.entries(counts).map(([type, count]) => `${type}(${count})`).join(', ') || '-'}`);
  if (result.parseErrors?.length) console.log(`    parseErrors=${result.parseErrors.join(' | ')}`);
  if (!result.ok && result.error) console.log(`    error=${result.error}`);
}

function parseSse(raw) {
  return raw
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const eventLine = frame.split(/\r?\n/).find((line) => line.startsWith('event:'));
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      if (data === '[DONE]') return { type: 'DONE', data };
      try {
        const parsed = JSON.parse(data);
        return { type: eventLine?.slice(6).trim() || parsed.type || 'unknown', data: parsed };
      } catch (error) {
        return { type: eventLine?.slice(6).trim() || 'unparseable', data, error: formatError(error) };
      }
    });
}

function countValues(values) {
  return values.reduce((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {});
}

function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function parseOptions(args) {
  return {
    help: args.includes('--help') || args.includes('-h'),
    skipProvider: args.includes('--skip-provider'),
    skipGateway: args.includes('--skip-gateway'),
    skipSdk: args.includes('--skip-sdk'),
  };
}

function printHelp() {
  console.log(`Usage: pnpm diagnose:responses [options]

Environment:
  RESPONSES_API_KEY          Provider API key (required for provider/gateway checks)
  RESPONSES_PROVIDER_URL     Provider base URL (default: ${DEFAULT_PROVIDER_URL})
  RESPONSES_GATEWAY_URL      Gateway base URL (default: ${DEFAULT_GATEWAY_URL})
  RESPONSES_PORTKEY_CONFIG   Full x-portkey-config JSON (optional)
  RESPONSES_MODEL             Model id (default: ${DEFAULT_MODEL})
  RESPONSES_PROMPT            Input text (default: ${DEFAULT_PROMPT})
  RESPONSES_TIMEOUT_MS        Request timeout (default: ${DEFAULT_TIMEOUT_MS})

Options:
  --skip-provider             Skip direct provider checks
  --skip-gateway              Skip local Gateway checks
  --skip-sdk                  Skip ai-sdk reproduction
  -h, --help                  Show this help`);
}

function formatError(error) {
  if (error?.name === 'AbortError') return `Request timed out after ${timeoutMs}ms`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}
