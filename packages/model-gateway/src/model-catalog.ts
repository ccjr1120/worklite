/**
 * Known model limits and optional prices. Matching is by model-id prefix, longest first, so a
 * dated or suffixed id inherits its family entry. An unknown model has no price (cost stays null,
 * never zero), no image capability and the conservative default context window.
 *
 * Built-in entries hold conservative input windows only. Prices are not built in: a wrong list
 * price would show a confident but false cost, so cost appears only for models priced in
 * WORKLITE_MODEL_CATALOG, a JSON object keyed by model-id prefix with the same fields, for example
 * {"claude-sonnet":{"contextWindow":200000,"images":true,"price":{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}}}.
 * Prices are USD per million tokens, for estimation only; a provider bill remains authoritative.
 */
export type ModelCatalogEntry = {
  contextWindow: number;
  /** The model accepts image input. Tool-produced images are only sent to such models. */
  images?: boolean;
  price?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
};

export const DEFAULT_CONTEXT_WINDOW = 128_000;

const BUILTIN: Record<string, ModelCatalogEntry> = {
  'claude-': { contextWindow: 200_000, images: true },
  'gpt-6': { contextWindow: 272_000, images: true },
  'gpt-5': { contextWindow: 272_000, images: true },
  'kimi-': { contextWindow: 128_000 },
  'deepseek-': { contextWindow: 128_000 },
  'glm-': { contextWindow: 128_000 },
};

let cachedOverrides: { raw: string | undefined; value: Record<string, ModelCatalogEntry> } | null = null;

function overrides(): Record<string, ModelCatalogEntry> {
  const raw = process.env.WORKLITE_MODEL_CATALOG;
  const cached = cachedOverrides;
  if (cached && cached.raw === raw) return cached.value;
  let value: Record<string, ModelCatalogEntry> = {};
  if (raw?.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        value = Object.fromEntries(Object.entries(parsed as Record<string, ModelCatalogEntry>)
          .filter(([, entry]) => entry && typeof entry === 'object' && Number.isSafeInteger(entry.contextWindow) && entry.contextWindow > 0));
      }
    } catch { /* an invalid override is ignored; built-in entries still apply */ }
  }
  cachedOverrides = { raw, value };
  return value;
}

export function modelCatalogEntry(modelId: string): ModelCatalogEntry | null {
  // A Gateway-qualified id ("provider/model") is matched on its model segment.
  const id = modelId.trim().toLowerCase().split('/').at(-1) ?? '';
  const entries = { ...BUILTIN, ...overrides() };
  const key = Object.keys(entries).filter((prefix) => id.startsWith(prefix.toLowerCase())).sort((a, b) => b.length - a.length)[0];
  return key ? entries[key]! : null;
}

export function modelContextWindow(modelId: string): number {
  return modelCatalogEntry(modelId)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

export type TokenUsageForCost = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
};

/**
 * Estimated USD cost of one request, or null without a known price or usage. inputTokens is the
 * AI SDK total (cached + uncached), so cached reads and writes are priced at their own rates
 * and only the remainder at the input rate.
 */
export function estimateModelCost(modelId: string, usage: TokenUsageForCost): number | null {
  const price = modelCatalogEntry(modelId)?.price;
  if (!price || usage.inputTokens === null || usage.outputTokens === null) return null;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const fresh = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  const cost = fresh * price.input + cacheRead * (price.cacheRead ?? price.input) + cacheWrite * (price.cacheWrite ?? price.input) + usage.outputTokens * price.output;
  return cost / 1_000_000;
}
