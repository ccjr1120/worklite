import { createRequire } from 'node:module';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { BadRequestException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import type { CodexAccountUsageSnapshot, CodexAuthStatus, CodexRateLimitSnapshot, CreateModelProviderRequest, DiscoverModelProviderRequest, DiscoverModelProviderResult, GatewayRequestLogDetail, GatewayRequestLogList, GatewayRequestLogQuery, GatewayTimeRange, ModelProviderProtocol, ModelProviderTestResult, ModelProviderView, PortkeyGatewayModelList, PortkeyGatewayStats, PortkeyGatewayStatus, PortkeyGatewayView, SystemOneTestInput, SystemOneWorkflowOutput, SystemOneWorkflowRequest, TestModelProviderRequest, UpdateModelProviderRequest } from '@worklite/contracts';
import type { ModelProviderConfig } from '@worklite/model-gateway';
import { agents, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';

const GATEWAY_PORT = Number(process.env.PORTKEY_GATEWAY_PORT ?? 23392);

const portkeyRequire = createRequire(__filename);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

type GatewayProxyOperation = 'models' | 'chat/completions' | 'responses' | 'messages' | 'images/generations' | 'systemone';

function forwardedHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) => {
      if (value === undefined || HOP_BY_HOP_HEADERS.has(name) || name === 'authorization' || name.startsWith('x-portkey-')) return [];
      return [[name, Array.isArray(value) ? value.join(', ') : value]];
    }),
  );
}

function responseHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) => {
      if (value === undefined || HOP_BY_HOP_HEADERS.has(name) || name.startsWith('x-portkey-')) return [];
      return [[name, Array.isArray(value) ? value.join(', ') : value]];
    }),
  );
}

function protocolParts(protocol: ModelProviderProtocol): { adapter: 'openai' | 'anthropic' | 'codex' | 'typesafe'; operation: 'chat/completions' | 'responses' | 'messages' | 'systemone' } {
  // The `typesafe` adapter name is only an operation-routing label: this protocol
  // is forwarded verbatim by the Gateway and never selects a Portkey adapter.
  if (protocol === 'typesafe/systemone') return { adapter: 'typesafe', operation: 'systemone' };
  if (protocol === 'anthropic/messages') return { adapter: 'anthropic', operation: 'messages' };
  if (protocol === 'codex/responses') return { adapter: 'codex', operation: 'responses' };
  if (protocol === 'openai/responses') return { adapter: 'openai', operation: 'responses' };
  if (protocol === 'openai/chat') return { adapter: 'openai', operation: 'chat/completions' };
  throw new BadRequestException('Unsupported model provider protocol.');
}

function discoveryConfig(input: DiscoverModelProviderRequest): ModelProviderConfig {
  const protocol = input.protocol;
  if (protocol !== 'openai/chat' && protocol !== 'openai/responses' && protocol !== 'anthropic/messages' && protocol !== 'codex/responses') throw new BadRequestException('Unsupported model provider protocol.');
  const apiKey = input.apiKey?.trim() ?? '';
  if (protocol !== 'codex/responses' && !apiKey) throw new BadRequestException('An API key is required to fetch models.');
  const baseURL = input.baseURL?.trim();
  if (!baseURL) throw new BadRequestException('Base URL is required to fetch models.');
  if (input.headers !== undefined && (input.headers === null || typeof input.headers !== 'object' || Array.isArray(input.headers) || Object.values(input.headers).some((value) => typeof value !== 'string'))) {
    throw new BadRequestException('Custom headers must be a JSON object with string values.');
  }
  const headers = input.headers === undefined ? undefined : Object.fromEntries(Object.entries(input.headers).map(([name, value]) => [name.trim().toLowerCase(), value]));
  if (headers && Object.keys(headers).some((name) => !name)) throw new BadRequestException('Custom header names must be non-empty.');
  // The guard above already excludes every protocol without a discovery adapter,
  // so this narrows to the Agent-capable adapters rather than widening the config.
  const adapter = protocol === 'anthropic/messages' ? 'anthropic' : protocol === 'codex/responses' ? 'codex' : 'openai';
  return { id: 'discovery', adapter, apiKey, baseURL, headers };
}

function discoveredModelIds(payload: unknown): string[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.values(payload).find((value) => Array.isArray(value)) ?? []
      : [];
  return [...new Set(rows.flatMap((row) => {
    if (typeof row === 'string') return [row.trim()];
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      for (const key of ['id', 'name', 'model']) {
        if (key in row && typeof row[key as keyof typeof row] === 'string') return [(row[key as keyof typeof row] as string).trim()];
      }
    }
    return [];
  }).filter(Boolean))];
}

function gatewayErrorMessage(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Portkey Gateway request failed.';
  const record = body as Record<string, unknown>;
  if (typeof record.message === 'string') return record.message;
  const error = record.error;
  if (error && typeof error === 'object' && !Array.isArray(error) && typeof (error as Record<string, unknown>).message === 'string') {
    return (error as Record<string, unknown>).message as string;
  }
  return 'Portkey Gateway request failed.';
}

function isSystemOneTestInput(value: unknown): value is SystemOneTestInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const state = record.state;
  const questions = record.questions;
  if (!state || typeof state !== 'object' || Array.isArray(state) || typeof (state as Record<string, unknown>).message !== 'string') return false;
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) return false;
  const connection = (questions as Record<string, unknown>).connection;
  return Boolean(connection && typeof connection === 'object' && !Array.isArray(connection)
    && (connection as Record<string, unknown>).type === 'noul'
    && typeof (connection as Record<string, unknown>).instructions === 'string');
}

@Injectable()
export class PortkeyGatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PortkeyGatewayService.name);
  private readonly activeGatewayPort = GATEWAY_PORT;
  private readonly managedGateway = process.env.WORKLITE_MANAGED_GATEWAY === '1';
  private gateway: ChildProcess | null = null;
  private gatewayReady = false;
  private startup: Promise<void> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private gatewayStatus: PortkeyGatewayStatus = 'starting';
  private gatewayError: string | null = null;
  private gatewayUpdatedAt = new Date().toISOString();

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  async status(): Promise<PortkeyGatewayView> {
    if (this.managedGateway) await this.refreshManagedStatus();
    return this.snapshot();
  }

  async providers(): Promise<ModelProviderView[]> {
    return this.gatewayJson<ModelProviderView[]>('/worklite/providers');
  }

  async stats(range: GatewayTimeRange = {}): Promise<PortkeyGatewayStats> {
    await this.ensureGatewayForDiscovery();
    const search = new URLSearchParams();
    if (range.from?.trim()) search.set('from', range.from.trim());
    if (range.to?.trim()) search.set('to', range.to.trim());
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return this.gatewayJson<PortkeyGatewayStats>(`/worklite/stats${suffix}`);
  }

  async requestLogs(query: GatewayRequestLogQuery): Promise<GatewayRequestLogList> {
    await this.ensureGatewayForDiscovery();
    const search = new URLSearchParams();
    if (query.from?.trim()) search.set('from', query.from.trim());
    if (query.to?.trim()) search.set('to', query.to.trim());
    if (query.provider?.trim()) search.set('provider', query.provider.trim());
    if (query.model?.trim()) search.set('model', query.model.trim());
    if (query.statusClass) search.set('statusClass', query.statusClass);
    if (query.workflowRunId?.trim()) search.set('workflowRunId', query.workflowRunId.trim());
    if (query.teamRunId?.trim()) search.set('teamRunId', query.teamRunId.trim());
    if (query.limit) search.set('limit', String(query.limit));
    if (query.cursor?.trim()) search.set('cursor', query.cursor.trim());
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return this.gatewayJson<GatewayRequestLogList>(`/worklite/request-logs${suffix}`);
  }

  async requestLog(requestLogId: string): Promise<GatewayRequestLogDetail> {
    await this.ensureGatewayForDiscovery();
    return this.gatewayJson<GatewayRequestLogDetail>(`/worklite/request-logs/${encodeURIComponent(requestLogId)}`);
  }

  async codexAuthStatus(): Promise<CodexAuthStatus> {
    await this.ensureGatewayForDiscovery();
    return this.gatewayJson<CodexAuthStatus>('/worklite/codex/auth/status');
  }

  async codexRateLimits(): Promise<CodexRateLimitSnapshot> {
    await this.ensureGatewayForDiscovery();
    return this.gatewayJson<CodexRateLimitSnapshot>('/worklite/codex/rate-limits');
  }

  async codexAccountUsages(): Promise<CodexAccountUsageSnapshot> {
    await this.ensureGatewayForDiscovery();
    return this.gatewayJson<CodexAccountUsageSnapshot>('/worklite/codex/accounts/usage');
  }

  async startCodexLogin(): Promise<{ authorizationUrl: string; sessionId: string }> {
    await this.ensureGatewayForDiscovery();
    return this.gatewayJson<{ authorizationUrl: string; sessionId: string }>('/worklite/codex/auth/login', { method: 'POST' });
  }

  async importCodexAccounts(input: unknown): Promise<CodexAuthStatus> {
    await this.ensureGatewayForDiscovery();
    return this.gatewayJson<CodexAuthStatus>('/worklite/codex/accounts/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  }

  async updateCodexAccount(accountId: string, enabled: boolean): Promise<CodexAuthStatus> {
    await this.ensureGatewayForDiscovery();
    return this.gatewayJson<CodexAuthStatus>(`/worklite/codex/accounts/${encodeURIComponent(accountId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
  }

  async refreshCodexAccount(accountId: string): Promise<CodexAuthStatus> {
    await this.ensureGatewayForDiscovery();
    return this.gatewayJson<CodexAuthStatus>(`/worklite/codex/accounts/${encodeURIComponent(accountId)}/refresh`, { method: 'POST' });
  }

  async deleteCodexAccount(accountId: string): Promise<CodexAuthStatus> {
    await this.ensureGatewayForDiscovery();
    return this.gatewayJson<CodexAuthStatus>(`/worklite/codex/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
  }

  async createProvider(input: CreateModelProviderRequest): Promise<ModelProviderView> {
    return this.gatewayJson<ModelProviderView>('/worklite/providers', { method: 'POST', body: JSON.stringify(input), headers: { 'content-type': 'application/json' } });
  }

  async updateProvider(providerId: string, input: UpdateModelProviderRequest): Promise<ModelProviderView> {
    const provider = await this.gatewayJson<ModelProviderView>(`/worklite/providers/${encodeURIComponent(providerId)}`, { method: 'PATCH', body: JSON.stringify(input), headers: { 'content-type': 'application/json' } });
    if (input.models !== undefined) {
      const fallbackModel = provider.models[0] ?? '';
      const boundAgents = await this.db.select({ id: agents.id, model: agents.model }).from(agents).where(eq(agents.providerId, providerId));
      for (const agent of boundAgents) {
        if (agent.model && provider.models.includes(agent.model)) continue;
        await this.db.update(agents).set({ model: fallbackModel, updatedAt: new Date() }).where(eq(agents.id, agent.id));
      }
    }
    return provider;
  }

  async deleteProvider(providerId: string) {
    await this.gatewayJson(`/worklite/providers/${encodeURIComponent(providerId)}`, { method: 'DELETE' });
    await this.db.update(agents).set({ providerId: null, model: '', updatedAt: new Date() }).where(eq(agents.providerId, providerId));
  }

  async testProvider(providerId: string, input: TestModelProviderRequest): Promise<ModelProviderTestResult> {
    return this.gatewayJson<ModelProviderTestResult>(`/worklite/providers/${encodeURIComponent(providerId)}/test`, { method: 'POST', body: JSON.stringify(input), headers: { 'content-type': 'application/json' } });
  }

  async models(_request: Request): Promise<PortkeyGatewayModelList> {
    await this.ensureGatewayForDiscovery();
    const providers = await this.providers();
    return {
      object: 'list',
      data: providers.flatMap((provider) => provider.models.map((model) => ({
        id: `${provider.name}/${model}`,
        object: 'model' as const,
        created: 0,
        owned_by: provider.name,
      }))),
    };
  }

  async start(): Promise<PortkeyGatewayView> {
    if (this.gatewayStatus === 'running') return this.snapshot();
    if (this.gatewayStatus === 'starting' && this.startup) {
      await this.startup.catch(() => undefined);
      return this.snapshot();
    }
    this.stopping = false;
    this.markStatus('starting', null);
    try {
      this.startup = this.startGateway();
      await this.startup;
      this.markStatus('running', null);
    } catch (error: unknown) {
      this.markStatus('failed', error instanceof Error ? error.message : 'Portkey Gateway failed to start.');
      this.scheduleRestart();
    } finally {
      this.startup = null;
    }
    return this.snapshot();
  }

  private async shutdown(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.stopping = true;
    const gateway = this.gateway;
    this.gatewayReady = false;
    this.gateway = null;
    if (gateway && !gateway.killed) {
      gateway.kill('SIGTERM');
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => {
          if (!gateway.killed) gateway.kill('SIGKILL');
          resolvePromise();
        }, 3_000);
        gateway.once('exit', () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
    }
    this.markStatus('failed', null);
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdown();
  }

  async proxy(request: Request, response: Response, providerId: string, operation: GatewayProxyOperation, selectedModel?: string): Promise<void> {
    await this.ensureGatewayForDiscovery();
    const provider = (await this.providers()).find((candidate) => candidate.id === providerId);
    if (!provider) throw new BadRequestException('Model provider not found.');
    const model = selectedModel?.trim() || provider.models[0];
    if (!model) throw new BadRequestException('Add at least one model id before using this provider.');
    if (selectedModel && !provider.models.includes(model)) throw new BadRequestException('The selected model is not configured for this provider.');
    const configuredProtocol = provider.protocol;
    const { operation: configuredOperation } = protocolParts(configuredProtocol);
    // System One is forwarded verbatim and shares no operation with the chat
    // protocols, so it is matched exactly instead of through the general rules.
    const operationSupported = configuredProtocol === 'typesafe/systemone' || operation === 'systemone'
      ? configuredProtocol === 'typesafe/systemone' && operation === 'systemone'
      : operation === 'models' || operation === configuredOperation || (configuredProtocol === 'codex/responses' && operation === 'images/generations');
    if (!operationSupported) throw new BadRequestException(`Provider protocol ${configuredProtocol} does not support ${operation}.`);
    const bodyValue = selectedModel && request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? { ...request.body, model }
      : request.body;
    const body = request.method === 'GET' || bodyValue === undefined ? undefined : JSON.stringify(bodyValue);
    const headers = {
      ...forwardedHeaders(request.headers),
      host: `127.0.0.1:${this.activeGatewayPort}`,
      'x-worklite-provider-id': providerId,
      ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
    };

    await new Promise<void>((resolvePromise) => {
      const upstream = httpRequest(
        { hostname: '127.0.0.1', port: this.activeGatewayPort, path: `/worklite/proxy/${operation}${request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''}`, method: request.method, headers },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers));
          upstreamResponse.pipe(response);
          upstreamResponse.once('end', resolvePromise);
          upstreamResponse.once('close', resolvePromise);
        },
      );
      upstream.on('error', () => {
        if (!response.headersSent) {
          response.status(502).json({ error: { message: 'Provider proxy request failed.' } });
        } else {
          response.end();
        }
        resolvePromise();
      });
      request.once('aborted', () => upstream.destroy());
      response.once('close', () => {
        if (!response.writableEnded) upstream.destroy();
      });
      if (body === undefined) upstream.end();
      else upstream.end(body);
    });
  }

  async generateImage(input: {
    prompt: string;
    model: string;
    n?: number;
    background?: string;
    quality?: string;
    size?: string;
    signal?: AbortSignal;
  }): Promise<{ type: 'workflow_image'; model: string; mediaType: 'image/png'; data: Array<{ b64Json: string }> }> {
    await this.ensureGatewayForDiscovery();
    const prompt = input.prompt.trim();
    const model = input.model.trim();
    const separator = model.indexOf('/');
    const providerName = separator > 0 ? model.slice(0, separator) : '';
    const modelId = separator > 0 ? model.slice(separator + 1) : '';
    if (!prompt) throw new BadRequestException('Image node requires a prompt.');
    if (model !== 'codex/gpt-image-2' || !providerName || !modelId) throw new BadRequestException('Image node requires the codex/gpt-image-2 model.');
    const provider = (await this.providers()).find((candidate) => candidate.name === providerName);
    if (!provider) throw new BadRequestException('Model provider not found.');
    if (provider.protocol !== 'codex/responses' || !provider.models.includes(modelId)) throw new BadRequestException('The Codex Provider does not support this image model.');

    const payload = await this.gatewayJson<{ data?: unknown }>(
      '/worklite/proxy/images/generations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worklite-provider-id': provider.id },
        body: JSON.stringify({ prompt, model: modelId, n: input.n, background: input.background, quality: input.quality, size: input.size }),
        signal: input.signal,
      },
    );
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const images = rows.flatMap((row): Array<{ b64Json: string }> => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
      const value = (row as Record<string, unknown>).b64_json;
      return typeof value === 'string' && value.trim() ? [{ b64Json: value.trim() }] : [];
    });
    if (images.length === 0) throw new ServiceUnavailableException('The image provider returned no generated PNG data.');
    return { type: 'workflow_image', model, mediaType: 'image/png', data: images };
  }

  async executeSystemOne(input: SystemOneWorkflowRequest & {
    workflowRunId: string;
    nodeRunId: string;
    signal?: AbortSignal;
  }): Promise<SystemOneWorkflowOutput> {
    await this.ensureGatewayForDiscovery();
    const model = input.model.trim();
    const separator = model.indexOf('/');
    const providerName = separator > 0 ? model.slice(0, separator).trim() : '';
    const modelId = separator > 0 ? model.slice(separator + 1).trim() : '';
    if (!providerName || !modelId) throw new BadRequestException('TypeSafe System One requires a public <providerName>/<modelId> model id.');
    const provider = (await this.providers()).find((candidate) => candidate.name === providerName);
    if (!provider) throw new BadRequestException('Model provider not found.');
    if (provider.protocol !== 'typesafe/systemone' || !provider.models.includes(modelId)) throw new BadRequestException('The selected TypeSafe model is not configured for this Provider.');
    const payload = await this.gatewayJson<SystemOneWorkflowOutput>('/worklite/proxy/systemone', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worklite-provider-id': provider.id,
        'x-worklite-log-id': `glog_${randomUUID()}`,
        'x-worklite-log-source': 'workflow',
        'x-worklite-workflow-run-id': input.workflowRunId,
        'x-worklite-node-run-id': input.nodeRunId,
      },
      body: JSON.stringify({ model: modelId, state: input.state, questions: input.questions }),
      signal: input.signal,
    });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new BadRequestException('TypeSafe provider returned an invalid System One response.');
    const answers = payload.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new BadRequestException('TypeSafe provider returned an invalid System One response.');
    return payload;
  }

  async proxyUnified(request: Request, response: Response, operation: Exclude<GatewayProxyOperation, 'models'>): Promise<void> {
    const model = request.body && typeof request.body === 'object' && !Array.isArray(request.body) && 'model' in request.body
      ? request.body.model
      : undefined;
    if (typeof model !== 'string') throw new BadRequestException('The model must use the <providerName>/<modelId> format.');
    const separator = model.indexOf('/');
    if (separator <= 0 || separator === model.length - 1) throw new BadRequestException('The model must use the <providerName>/<modelId> format.');
    const providerName = model.slice(0, separator).trim();
    const modelId = model.slice(separator + 1).trim();
    if (!providerName || !modelId) throw new BadRequestException('The model must use the <providerName>/<modelId> format.');
    const provider = (await this.providers()).find((candidate) => candidate.name === providerName);
    if (!provider) throw new BadRequestException('Model provider not found.');
    await this.proxy(request, response, provider.id, operation, modelId);
  }

  async discoverModels(input: DiscoverModelProviderRequest): Promise<DiscoverModelProviderResult> {
    const provider = discoveryConfig(input);
    await this.ensureGatewayForDiscovery();
    const customHeaders = provider.headers ?? {};
    const config: Record<string, unknown> = {
      provider: provider.adapter,
      api_key: provider.apiKey,
      custom_host: provider.baseURL,
      ...(Object.keys(customHeaders).length > 0 ? { forward_headers: Object.keys(customHeaders) } : {}),
    };
    const headers = {
      ...customHeaders,
      host: `127.0.0.1:${this.activeGatewayPort}`,
      'x-portkey-config': JSON.stringify(config),
    };
    const payload = await new Promise<unknown>((resolvePromise, rejectPromise) => {
      const upstream = httpRequest({ hostname: '127.0.0.1', port: this.activeGatewayPort, path: '/v1/models', method: 'GET', headers }, (upstreamResponse) => {
        const chunks: Buffer[] = [];
        upstreamResponse.on('data', (chunk: Buffer) => chunks.push(chunk));
        upstreamResponse.once('end', () => {
          const status = upstreamResponse.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            rejectPromise(new ServiceUnavailableException(`The provider did not return a model list (HTTP ${status}).`));
            return;
          }
          try {
            resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            rejectPromise(new ServiceUnavailableException('The provider returned an invalid model list.'));
          }
        });
      });
      upstream.on('error', () => rejectPromise(new ServiceUnavailableException('Provider model discovery failed.')));
      upstream.end();
    });
    const models = discoveredModelIds(payload);
    if (models.length === 0) throw new ServiceUnavailableException('The provider returned no usable models.');
    return { models };
  }

  private async refreshManagedStatus(): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.activeGatewayPort}/`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        this.gatewayReady = true;
        this.markStatus('running', null);
        return true;
      }
    } catch {
      // The independent Gateway supervisor retries a failed child process.
    }
    this.gatewayReady = false;
    this.markStatus('failed', 'Portkey Gateway is unavailable while it is restarting.');
    return false;
  }

  private async gatewayJson<T>(path: string, init?: RequestInit): Promise<T> {
    let response: globalThis.Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.activeGatewayPort}${path}`, init);
    } catch {
      throw new ServiceUnavailableException('Portkey Gateway is unavailable while it is starting or recovering.');
    }
    const text = await response.text();
    let body: unknown = undefined;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
    if (!response.ok) {
      const message = gatewayErrorMessage(body);
      const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
      const details = {
        ...(typeof record?.requestLogId === 'string' ? { requestLogId: record.requestLogId } : {}),
        ...(isSystemOneTestInput(record?.testInput) ? { testInput: record.testInput } : {}),
      };
      throw new BadRequestException(Object.keys(details).length > 0 ? { message, ...details } : message);
    }
    return body as T;
  }

  private async ensureGatewayForDiscovery(): Promise<void> {
    if (this.managedGateway && await this.refreshManagedStatus()) return;
    if (this.gatewayReady && this.gatewayStatus === 'running') return;
    const gateway = await this.start();
    if (gateway.status !== 'running') throw new ServiceUnavailableException(gateway.error ?? 'Portkey Gateway failed to start for model discovery.');
  }

  private async startGateway(): Promise<void> {
    if (this.managedGateway) return this.waitUntilReady();
    if (this.gateway && !this.gateway.killed) return this.waitUntilReady();
    const gatewayEntry = portkeyRequire.resolve('@portkey-ai/gateway/build/start-server.js');
    const preload = resolve(process.cwd(), 'portkey-local-bind.cjs');
    const child = spawn(process.execPath, ['-r', preload, gatewayEntry, `--port=${this.activeGatewayPort}`, '--headless'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(this.activeGatewayPort),
        TRUSTED_CUSTOM_HOSTS: this.trustedHosts(),
        PORTKEY_GATEWAY_DB_PATH: this.gatewayDatabasePath(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.gateway = child;
    child.stdout?.on('data', (chunk: Buffer) => this.logger.debug(String(chunk).trim()));
    child.stderr?.on('data', (chunk: Buffer) => this.logger.warn(String(chunk).trim()));
    child.once('error', (error) => {
      this.gatewayReady = false;
      this.markStatus('failed', error.message);
      if (this.gateway === child) this.gateway = null;
      this.logger.warn(`Portkey Gateway process failed: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      this.gatewayReady = false;
      if (!this.stopping) {
        this.markStatus('failed', `Portkey Gateway exited (${code ?? 'no code'}${signal ? `, ${signal}` : ''}).`);
        this.scheduleRestart();
      }
      if (this.gateway === child) this.gateway = null;
      if (!this.stopping) this.logger.warn(`Portkey Gateway exited (${code ?? 'no code'}${signal ? `, ${signal}` : ''}).`);
    });
    try {
      await this.waitUntilReady();
    } catch (error) {
      if (!child.killed) child.kill('SIGTERM');
      if (this.gateway === child) this.gateway = null;
      throw error;
    }
  }

  private async waitUntilReady(): Promise<void> {
    // The first start after enabling incremental auto-vacuum rewrites the whole
    // Gateway database before listening, so readiness allows minutes rather than
    // seconds and ends as soon as the process exits.
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      if (!this.managedGateway && !this.gateway) throw new Error('Portkey Gateway exited before it became ready.');
      try {
        const response = await fetch(`http://127.0.0.1:${this.activeGatewayPort}/`, { signal: AbortSignal.timeout(500) });
        if (response.ok) {
          this.gatewayReady = true;
          return;
        }
      } catch {
        // The sidecar may need a few attempts to bind its internal port.
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    throw new Error(`Portkey Gateway did not become ready on port ${this.activeGatewayPort}.`);
  }

  private markStatus(status: PortkeyGatewayStatus, error: string | null): void {
    this.gatewayStatus = status;
    this.gatewayError = error;
    this.gatewayUpdatedAt = new Date().toISOString();
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, 250);
  }

  private snapshot(): PortkeyGatewayView {
    return { port: GATEWAY_PORT, host: '127.0.0.1', status: this.gatewayStatus, error: this.gatewayError, updatedAt: this.gatewayUpdatedAt };
  }

  private trustedHosts(): string {
    const configured = process.env.PORTKEY_TRUSTED_CUSTOM_HOSTS?.trim();
    return configured || 'localhost,127.0.0.1,::1,host.docker.internal';
  }

  private gatewayDatabasePath(): string {
    const configured = process.env.PORTKEY_GATEWAY_DB_PATH?.trim();
    return resolve(process.cwd(), configured || '../../.data/deployment/worklite-gateway.db');
  }

}
