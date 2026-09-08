import { createRequire } from 'node:module';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { BadRequestException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import type { CodexAuthStatus, CodexRateLimitSnapshot, CreateModelProviderRequest, DiscoverModelProviderRequest, DiscoverModelProviderResult, ModelProviderProtocol, ModelProviderTestResult, ModelProviderView, PortkeyGatewayModelList, PortkeyGatewayStats, PortkeyGatewayStatsWindow, PortkeyGatewayStatus, PortkeyGatewayView, TestModelProviderRequest, UpdateModelProviderRequest } from '@worklite/contracts';
import type { ModelProviderConfig } from '@worklite/model-gateway';
import { agents, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';

const GATEWAY_PORT = Number(process.env.PORTKEY_GATEWAY_PORT ?? 4547);

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

function protocolParts(protocol: ModelProviderProtocol): { adapter: 'openai' | 'codex' | 'deepseek'; operation: 'chat/completions' | 'responses' } {
  if (protocol === 'deepseek/chat') return { adapter: 'deepseek', operation: 'chat/completions' };
  if (protocol === 'codex/responses') return { adapter: 'codex', operation: 'responses' };
  if (protocol === 'openai/responses') return { adapter: 'openai', operation: 'responses' };
  return { adapter: 'openai', operation: 'chat/completions' };
}

function discoveryConfig(input: DiscoverModelProviderRequest): ModelProviderConfig {
  const apiKey = input.apiKey?.trim() ?? '';
  if (input.protocol !== 'codex/responses' && !apiKey) throw new BadRequestException('An API key is required to fetch models.');
  const baseURL = input.baseURL?.trim();
  if (!baseURL) throw new BadRequestException('Base URL is required to fetch models.');
  const protocol = input.protocol ?? 'openai/chat';
  if (protocol !== 'openai/chat' && protocol !== 'openai/responses' && protocol !== 'codex/responses' && protocol !== 'deepseek/chat') throw new BadRequestException('Unsupported model provider protocol.');
  if (input.headers !== undefined && (input.headers === null || typeof input.headers !== 'object' || Array.isArray(input.headers) || Object.values(input.headers).some((value) => typeof value !== 'string'))) {
    throw new BadRequestException('Custom headers must be a JSON object with string values.');
  }
  const headers = input.headers === undefined ? undefined : Object.fromEntries(Object.entries(input.headers).map(([name, value]) => [name.trim().toLowerCase(), value]));
  if (headers && Object.keys(headers).some((name) => !name)) throw new BadRequestException('Custom header names must be non-empty.');
  const { adapter } = protocolParts(protocol);
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

@Injectable()
export class PortkeyGatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PortkeyGatewayService.name);
  private readonly activeGatewayPort = GATEWAY_PORT;
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
    return this.snapshot();
  }

  async providers(): Promise<ModelProviderView[]> {
    return this.gatewayJson<ModelProviderView[]>('/worklite/providers');
  }

  async stats(window?: string): Promise<PortkeyGatewayStats> {
    const requested = window === '7d' || window === '30d' ? window : '24h';
    await this.ensureGatewayForDiscovery();
    return this.gatewayJson<PortkeyGatewayStats>(`/worklite/stats?window=${requested as PortkeyGatewayStatsWindow}`);
  }

  async codexAuthStatus(): Promise<CodexAuthStatus> {
    await this.ensureGatewayForDiscovery();
    return this.gatewayJson<CodexAuthStatus>('/worklite/codex/auth/status');
  }

  async codexRateLimits(): Promise<CodexRateLimitSnapshot> {
    await this.ensureGatewayForDiscovery();
    return this.gatewayJson<CodexRateLimitSnapshot>('/worklite/codex/rate-limits');
  }

  async startCodexLogin(): Promise<{ authorizationUrl: string; sessionId: string }> {
    await this.ensureGatewayForDiscovery();
    return this.gatewayJson<{ authorizationUrl: string; sessionId: string }>('/worklite/codex/auth/login', { method: 'POST' });
  }

  async refreshCodexCredential(): Promise<CodexAuthStatus> {
    await this.ensureGatewayForDiscovery();
    return this.gatewayJson<CodexAuthStatus>('/worklite/codex/auth/refresh', { method: 'POST' });
  }

  async logoutCodex(): Promise<CodexAuthStatus> {
    await this.ensureGatewayForDiscovery();
    return this.gatewayJson<CodexAuthStatus>('/worklite/codex/auth/logout', { method: 'POST' });
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

  async models(request: Request): Promise<PortkeyGatewayModelList> {
    this.ensureGateway();
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

  async proxy(request: Request, response: Response, providerId: string, operation: 'models' | 'chat/completions' | 'responses', selectedModel?: string): Promise<void> {
    this.ensureGateway();
    const provider = (await this.providers()).find((candidate) => candidate.id === providerId);
    if (!provider) throw new BadRequestException('Model provider not found.');
    const model = selectedModel?.trim() || provider.models[0];
    if (!model) throw new BadRequestException('Add at least one model id before using this provider.');
    if (selectedModel && !provider.models.includes(model)) throw new BadRequestException('The selected model is not configured for this provider.');
    const configuredProtocol = provider.protocol;
    const { operation: configuredOperation } = protocolParts(configuredProtocol);
    if (operation !== 'models' && operation !== configuredOperation) throw new BadRequestException(`Provider protocol ${configuredProtocol} does not support ${operation}.`);
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

  async proxyUnified(request: Request, response: Response, operation: 'chat/completions' | 'responses'): Promise<void> {
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

  private ensureGateway(): void {
    if (!this.gatewayReady || this.gatewayStatus !== 'running') throw new ServiceUnavailableException('Portkey Gateway is unavailable while it is starting or recovering.');
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
      const message = body && typeof body === 'object' && !Array.isArray(body) && 'message' in body && typeof body.message === 'string' ? body.message : 'Portkey Gateway request failed.';
      throw new BadRequestException(message);
    }
    return body as T;
  }

  private async ensureGatewayForDiscovery(): Promise<void> {
    if (this.gatewayReady && this.gatewayStatus === 'running') return;
    const gateway = await this.start();
    if (gateway.status !== 'running') throw new ServiceUnavailableException(gateway.error ?? 'Portkey Gateway failed to start for model discovery.');
  }

  private async startGateway(): Promise<void> {
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
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
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
    return resolve(process.cwd(), configured || 'data/worklite-gateway.db');
  }

}
