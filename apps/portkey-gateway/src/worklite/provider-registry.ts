import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export type GatewayProviderProtocol = 'openai/chat' | 'openai/responses' | 'deepseek/chat';

export type GatewayProvider = {
  id: string;
  name: string;
  protocol: GatewayProviderProtocol;
  baseURL: string;
  apiKey: string;
  models: string[];
  headers?: Record<string, string>;
  updatedAt: string;
};

export type GatewayProviderView = Omit<GatewayProvider, 'apiKey' | 'headers'> & {
  status: 'connected' | 'unconfigured' | 'invalid';
  maskedKey: string;
  headerNames: string[];
};

const VALID_PROTOCOLS: GatewayProviderProtocol[] = ['openai/chat', 'openai/responses', 'deepseek/chat'];

function storePath(): string {
  return resolve(process.cwd(), process.env.PORTKEY_PROVIDER_STORE?.trim() || 'data/worklite-providers.json');
}

function maskSecret(value: string): string {
  return value.length > 4 ? `****${value.slice(-4)}` : '****';
}

function view(provider: GatewayProvider): GatewayProviderView {
  return { id: provider.id, name: provider.name, protocol: provider.protocol, baseURL: provider.baseURL, models: provider.models, updatedAt: provider.updatedAt, status: provider.apiKey ? 'connected' : 'unconfigured', maskedKey: provider.apiKey ? maskSecret(provider.apiKey) : '', headerNames: Object.keys(provider.headers ?? {}) };
}

async function readProviders(): Promise<GatewayProvider[]> {
  try {
    const raw = await readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as GatewayProvider[] : [];
  } catch {
    return [];
  }
}

async function writeProviders(providers: GatewayProvider[]): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(providers, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tempPath, path);
}

function validateInput(input: unknown, partial = false): Partial<GatewayProvider> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Provider configuration must be an object.');
  const value = input as Record<string, unknown>;
  const result: Partial<GatewayProvider> = {};
  if (!partial || 'name' in value) {
    if (typeof value.name !== 'string' || !value.name.trim()) throw new Error('Provider name is required.');
    result.name = value.name.trim();
  }
  if (!partial || 'baseURL' in value) {
    if (typeof value.baseURL !== 'string' || !value.baseURL.trim()) throw new Error('Base URL is required.');
    result.baseURL = value.baseURL.trim();
  }
  if (!partial || 'protocol' in value) {
    if (!VALID_PROTOCOLS.includes(value.protocol as GatewayProviderProtocol)) throw new Error('Unsupported model provider protocol.');
    result.protocol = value.protocol as GatewayProviderProtocol;
  }
  if (!partial || 'models' in value) {
    if (!Array.isArray(value.models) || value.models.some((model) => typeof model !== 'string')) throw new Error('Models must be an array of strings.');
    result.models = [...new Set(value.models.map((model) => model.trim()).filter(Boolean))];
  }
  if ('apiKey' in value && value.apiKey !== undefined) {
    if (typeof value.apiKey !== 'string') throw new Error('API key must be a string.');
    result.apiKey = value.apiKey.trim();
  }
  if ('headers' in value && value.headers !== undefined) {
    if (!value.headers || typeof value.headers !== 'object' || Array.isArray(value.headers) || Object.values(value.headers).some((header) => typeof header !== 'string')) throw new Error('Custom headers must be an object with string values.');
    result.headers = Object.fromEntries(Object.entries(value.headers).map(([name, header]) => [name.trim().toLowerCase(), header as string]));
  }
  return result;
}

export async function listProviders(): Promise<GatewayProviderView[]> {
  return (await readProviders()).sort((left, right) => left.name.localeCompare(right.name)).map(view);
}

export async function createProvider(input: unknown): Promise<GatewayProviderView> {
  const values = validateInput(input);
  const providers = await readProviders();
  if (providers.some((provider) => provider.name === values.name)) throw new Error('A provider with this name already exists.');
  const requestedId = input && typeof input === 'object' && !Array.isArray(input) && typeof (input as Record<string, unknown>).id === 'string' ? (input as Record<string, unknown>).id as string : undefined;
  const provider: GatewayProvider = { id: requestedId?.trim() || `prov_${randomUUID()}`, name: values.name!, protocol: values.protocol!, baseURL: values.baseURL!, apiKey: values.apiKey ?? '', models: values.models ?? [], ...(values.headers ? { headers: values.headers } : {}), updatedAt: new Date().toISOString() };
  providers.push(provider);
  await writeProviders(providers);
  return view(provider);
}

export async function updateProvider(id: string, input: unknown): Promise<GatewayProviderView> {
  const providers = await readProviders();
  const index = providers.findIndex((provider) => provider.id === id);
  if (index < 0) throw new Error('Model provider not found.');
  const values = validateInput(input, true);
  if (values.name && providers.some((provider, providerIndex) => providerIndex !== index && provider.name === values.name)) throw new Error('A provider with this name already exists.');
  const current = providers[index];
  providers[index] = { ...current, ...values, ...(values.apiKey === undefined ? {} : { apiKey: values.apiKey }), updatedAt: new Date().toISOString() };
  await writeProviders(providers);
  return view(providers[index]);
}

export async function deleteProvider(id: string): Promise<void> {
  const providers = await readProviders();
  const next = providers.filter((provider) => provider.id !== id);
  if (next.length === providers.length) throw new Error('Model provider not found.');
  await writeProviders(next);
}

export async function getProvider(id: string): Promise<GatewayProvider | undefined> {
  return (await readProviders()).find((provider) => provider.id === id);
}

export function providerView(provider: GatewayProvider): GatewayProviderView {
  return view(provider);
}
