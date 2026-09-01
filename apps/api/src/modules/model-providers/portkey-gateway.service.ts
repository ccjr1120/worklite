import { createRequire } from 'node:module';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { DiscoverModelProviderRequest, DiscoverModelProviderResult, ModelProviderProtocol, PortkeyGatewayStatus, PortkeyGatewayView, UpdatePortkeyGatewayRequest } from '@worklite/contracts';
import type { ModelProviderConfig } from '@worklite/model-gateway';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { DATABASE } from '../../infrastructure/database.module';
import { workspaceSettings, type Database } from '@worklite/db';
import { eq } from 'drizzle-orm';

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

function configuredPort(): number {
  const value = Number.parseInt(process.env.PORTKEY_GATEWAY_PORT ?? '4547', 10);
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : 4547;
}

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

function protocolParts(protocol: ModelProviderProtocol): { adapter: 'openai' | 'deepseek'; operation: 'chat/completions' | 'responses' } {
  if (protocol === 'deepseek/chat') return { adapter: 'deepseek', operation: 'chat/completions' };
  if (protocol === 'openai/responses') return { adapter: 'openai', operation: 'responses' };
  return { adapter: 'openai', operation: 'chat/completions' };
}

function discoveryConfig(input: DiscoverModelProviderRequest): ModelProviderConfig {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new BadRequestException('An API key is required to fetch models.');
  const baseURL = input.baseURL?.trim();
  if (!baseURL) throw new BadRequestException('Base URL is required to fetch models.');
  const protocol = input.protocol ?? 'openai/chat';
  if (protocol !== 'openai/chat' && protocol !== 'openai/responses' && protocol !== 'deepseek/chat') throw new BadRequestException('Unsupported model provider protocol.');
  if (input.headers !== undefined && (input.headers === null || typeof input.headers !== 'object' || Array.isArray(input.headers) || Object.values(input.headers).some((value) => typeof value !== 'string'))) {
    throw new BadRequestException('Custom headers must be a JSON object with string values.');
  }
  const headers = input.headers === undefined ? undefined : Object.fromEntries(Object.entries(input.headers).map(([name, value]) => [name.trim().toLowerCase(), value]));
  if (headers && Object.keys(headers).some((name) => !name)) throw new BadRequestException('Custom header names must be non-empty.');
  const { adapter } = protocolParts(protocol);
  return { id: 'discovery', adapter, apiKey, baseURL, headers };
}

@Injectable()
export class PortkeyGatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PortkeyGatewayService.name);
  private configuredGatewayPort = configuredPort();
  private activeGatewayPort = this.configuredGatewayPort;
  private gateway: ChildProcess | null = null;
  private gatewayReady = false;
  private startup: Promise<void> | null = null;
  private stopping = false;
  private gatewayStatus: PortkeyGatewayStatus = 'stopped';
  private gatewayError: string | null = null;
  private gatewayUpdatedAt = new Date().toISOString();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly resources: WorkspaceResourcesService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  async status(): Promise<PortkeyGatewayView> {
    await this.loadConfiguredPort();
    return this.snapshot();
  }

  async updateGateway(input: UpdatePortkeyGatewayRequest): Promise<PortkeyGatewayView> {
    if (!input || !Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) throw new BadRequestException('Gateway port must be an integer between 1 and 65535.');
    const [row] = await this.db.update(workspaceSettings).set({ portkeyGatewayPort: input.port, updatedAt: new Date() }).where(eq(workspaceSettings.workspaceId, 'workspace_personal')).returning();
    if (!row) throw new ConflictException('Workspace settings are unavailable.');
    this.configuredGatewayPort = input.port;
    process.env.PORTKEY_GATEWAY_PORT = String(input.port);
    this.markStatus(this.gatewayStatus, null);
    return this.snapshot();
  }

  async start(): Promise<PortkeyGatewayView> {
    await this.loadConfiguredPort();
    if (this.gatewayStatus === 'running') return this.snapshot();
    if (this.gatewayStatus === 'starting') {
      if (this.startup) await this.startup.catch(() => undefined);
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
    } finally {
      this.startup = null;
    }
    return this.snapshot();
  }

  async stop(): Promise<PortkeyGatewayView> {
    if (this.gatewayStatus === 'stopped') return this.snapshot();
    this.markStatus('stopping', null);
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
    this.markStatus('stopped', null);
    return this.snapshot();
  }

  async restart(): Promise<PortkeyGatewayView> {
    await this.stop();
    return this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async proxy(request: Request, response: Response, providerId: string, operation: 'models' | 'chat/completions' | 'responses'): Promise<void> {
    const runtime = await this.resources.providerRuntime(request, 'personal', providerId);
    this.ensureGateway();

    const provider = runtime.provider;
    const configuredProtocol = runtime.protocol;
    const { adapter: portkeyProvider, operation: configuredOperation } = protocolParts(configuredProtocol);
    if (operation !== 'models' && operation !== configuredOperation) throw new BadRequestException(`Provider protocol ${configuredProtocol} does not support ${operation}.`);
    const customHeaders = Object.fromEntries(Object.entries(provider.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    const config: Record<string, unknown> = {
      provider: portkeyProvider,
      api_key: provider.apiKey,
      ...(provider.baseURL ? { custom_host: provider.baseURL } : {}),
      ...(Object.keys(customHeaders).length > 0 ? { forward_headers: Object.keys(customHeaders) } : {}),
    };
    const body = request.method === 'GET' || request.body === undefined ? undefined : JSON.stringify(request.body);
    const headers = {
      ...forwardedHeaders(request.headers),
      ...customHeaders,
      host: `127.0.0.1:${this.activeGatewayPort}`,
      'x-portkey-config': JSON.stringify(config),
      ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
    };

    await new Promise<void>((resolvePromise) => {
      const upstream = httpRequest(
        { hostname: '127.0.0.1', port: this.activeGatewayPort, path: `/v1/${operation}${request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''}`, method: request.method, headers },
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
          if ((upstreamResponse.statusCode ?? 500) < 200 || (upstreamResponse.statusCode ?? 500) >= 300) {
            rejectPromise(new ServiceUnavailableException('The provider did not return a model list.'));
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
    const rows = payload && typeof payload === 'object' && !Array.isArray(payload) && 'data' in payload && Array.isArray(payload.data) ? payload.data : [];
    const models = [...new Set(rows.flatMap((row) => row && typeof row === 'object' && !Array.isArray(row) && 'id' in row && typeof row.id === 'string' ? [row.id.trim()] : []).filter(Boolean))];
    if (models.length === 0) throw new ServiceUnavailableException('The provider returned no usable models.');
    return { models };
  }

  private ensureGateway(): void {
    if (!this.gatewayReady || this.gatewayStatus !== 'running') throw new ServiceUnavailableException('Portkey Gateway is unavailable. Start the Gateway before sending proxy requests.');
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
    this.activeGatewayPort = this.configuredGatewayPort;
    const child = spawn(process.execPath, ['-r', preload, gatewayEntry, `--port=${this.activeGatewayPort}`, '--headless'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(this.activeGatewayPort), TRUSTED_CUSTOM_HOSTS: this.trustedHosts() },
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
      if (!this.stopping) this.markStatus('failed', `Portkey Gateway exited (${code ?? 'no code'}${signal ? `, ${signal}` : ''}).`);
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

  private async loadConfiguredPort(): Promise<void> {
    const [row] = await this.db.select({ port: workspaceSettings.portkeyGatewayPort }).from(workspaceSettings).limit(1);
    if (row && Number.isInteger(row.port) && row.port > 0 && row.port <= 65_535) {
      this.configuredGatewayPort = row.port;
      process.env.PORTKEY_GATEWAY_PORT = String(row.port);
    }
  }

  private markStatus(status: PortkeyGatewayStatus, error: string | null): void {
    this.gatewayStatus = status;
    this.gatewayError = error;
    this.gatewayUpdatedAt = new Date().toISOString();
  }

  private snapshot(): PortkeyGatewayView {
    return { port: this.configuredGatewayPort, host: '127.0.0.1', status: this.gatewayStatus, error: this.gatewayError, updatedAt: this.gatewayUpdatedAt };
  }

  private trustedHosts(): string {
    const configured = process.env.PORTKEY_TRUSTED_CUSTOM_HOSTS?.trim();
    return configured || 'localhost,127.0.0.1,::1,host.docker.internal';
  }
}
