import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { WEB_SEARCH_API_KEY_ENV_KEY } from './web-search-api-key';

const SEARCH_ENDPOINT = 'https://open.feedcoopapi.com/search_api/web_search';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_UPSTREAM_RESPONSE_BYTES = 8_000_000;
const MAX_OUTPUT_CHARS = 16_000;
const SUMMARY_CHARS = 1_200;
const SNIPPET_CHARS = 500;
const CONTENT_CHARS = 4_000;

const TIME_RANGES = ['OneDay', 'OneWeek', 'OneMonth', 'OneYear'] as const;
const INDUSTRIES = ['finance', 'game', 'health', 'gov'] as const;

// Documented Volcengine search failures worth translating into an action.
const ERROR_MESSAGES: Record<string, string> = {
  '10406': 'The Volcengine web search free quota is exhausted. Check the account quota or buy a package.',
  '10408': 'Volcengine web search is not activated for this account. Subscribe to the search service first.',
  '10412': 'The Volcengine web search package has no remaining quota.',
  '700429': 'Volcengine web search rate limit exceeded (QPS). Wait briefly and retry.',
};

export type VolcengineSearchParams = {
  query: string;
  count?: number;
  timeRange?: string;
  searchType?: 'web' | 'image';
  sites?: string[];
  blockHosts?: string[];
  needContent?: boolean;
  needUrl?: boolean;
  authInfoLevel?: 0 | 1;
  icpHostOnly?: boolean;
  queryRewrite?: boolean;
  contentFormats?: Array<'text' | 'markdown'>;
  industry?: (typeof INDUSTRIES)[number];
  enableWaiting?: boolean;
  maxWaitTime?: number;
};

export type WebSearchItem = {
  title: string;
  url: string;
  siteName: string | null;
  snippet: string | null;
  summary: string | null;
  publishTime: string | null;
  rankScore: number | null;
  authInfoDes: string | null;
  authInfoLevel: number | null;
  content: string | null;
  contentTruncated: boolean;
};

export type WebSearchResponse = {
  query: string;
  resultCount: number | null;
  timeCostMs: number | null;
  logId: string | null;
  searchContext: string | null;
  results: WebSearchItem[];
  omittedResults: number;
  truncated: boolean;
  note: string | null;
};

@Injectable()
export class VolcengineSearchService {
  /**
   * Runs one web search. The caller resolves the key from the API environment or
   * an inbound bearer token; the key never appears in the result or an error.
   */
  async search(raw: unknown, apiKey: string | null): Promise<WebSearchResponse> {
    const params = normalizeSearchParams(raw);
    if (!apiKey) {
      throw new ServiceUnavailableException(`Web search is not configured. Set ${WEB_SEARCH_API_KEY_ENV_KEY} in the WorkLite API environment first.`);
    }
    const timeoutMs = params.maxWaitTime === undefined
      ? DEFAULT_TIMEOUT_MS
      : Math.min(45_000, Math.max(DEFAULT_TIMEOUT_MS, (params.maxWaitTime + 5) * 1_000));
    const response = await fetch(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(searchRequestBody(params)),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error: unknown): never => {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'the request timed out' : 'the search service is unreachable';
      throw new ServiceUnavailableException(`Volcengine web search failed: ${reason}.`);
    });
    const text = await readUpstreamResponse(response);
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    const errorCode = errorCodeOf(body);
    if (errorCode) throw new ServiceUnavailableException(errorMessage(errorCode, upstreamMessage(body), apiKey));
    if (!response.ok) {
      const status = `HTTP ${response.status}`;
      throw new ServiceUnavailableException(`Volcengine web search failed (${status})${upstreamMessage(body) ? `: ${sanitize(upstreamMessage(body)!, apiKey)}` : '.'}`);
    }
    if (!body || typeof body !== 'object') {
      throw new ServiceUnavailableException('Volcengine web search returned an unreadable response.');
    }
    return mapResponse(params, body as Record<string, unknown>, apiKey);
  }
}

function searchRequestBody(params: VolcengineSearchParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    Query: params.query,
    SearchType: params.searchType ?? 'web',
    Count: params.count ?? 10,
  };
  if (params.timeRange) body.TimeRange = params.timeRange;
  const filter: Record<string, unknown> = {
    NeedContent: params.needContent ?? false,
    NeedUrl: params.needUrl ?? true,
  };
  if (params.sites?.length) filter.Sites = params.sites.join('|');
  if (params.blockHosts?.length) filter.BlockHosts = params.blockHosts.join('|');
  if (params.authInfoLevel !== undefined) filter.AuthInfoLevel = params.authInfoLevel;
  if (params.icpHostOnly !== undefined) filter.IcpHostOnly = params.icpHostOnly;
  body.Filter = filter;
  if (params.queryRewrite !== undefined) body.QueryControl = { QueryRewrite: params.queryRewrite };
  if (params.contentFormats?.length) body.ContentFormats = params.contentFormats;
  if (params.industry) body.Industry = params.industry;
  if (params.enableWaiting !== undefined) body.EnableWaiting = params.enableWaiting;
  if (params.maxWaitTime !== undefined) body.MaxWaitTime = params.maxWaitTime;
  return body;
}

function normalizeSearchParams(raw: unknown): VolcengineSearchParams {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Web search input must be an object.');
  const value = raw as Record<string, unknown>;
  const query = typeof value.query === 'string' ? value.query.trim() : '';
  if (!query) throw new BadRequestException('query is required.');
  if (query.length > 100) throw new BadRequestException('query must be no longer than 100 characters.');

  const count = value.count === undefined ? 10 : value.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 50) throw new BadRequestException('count must be an integer from 1 to 50.');

  const searchType = value.searchType === undefined ? 'web' : value.searchType;
  if (searchType !== 'web' && searchType !== 'image') throw new BadRequestException("searchType must be 'web' or 'image'.");

  const timeRange = value.timeRange === undefined ? undefined : value.timeRange;
  if (timeRange !== undefined && (typeof timeRange !== 'string' || !isTimeRange(timeRange))) {
    throw new BadRequestException('timeRange must be OneDay, OneWeek, OneMonth, OneYear, or two YYYY-MM-DD dates joined by "..".');
  }

  const sites = stringList(value.sites, 'sites', 20, 253);
  const blockHosts = stringList(value.blockHosts, 'blockHosts', 5, 253);

  const needContent = optionalBoolean(value.needContent, 'needContent');
  const needUrl = optionalBoolean(value.needUrl, 'needUrl');
  const icpHostOnly = optionalBoolean(value.icpHostOnly, 'icpHostOnly');
  const queryRewrite = optionalBoolean(value.queryRewrite, 'queryRewrite');
  const enableWaiting = optionalBoolean(value.enableWaiting, 'enableWaiting');

  const authInfoLevel = value.authInfoLevel === undefined ? undefined : value.authInfoLevel;
  if (authInfoLevel !== undefined && authInfoLevel !== 0 && authInfoLevel !== 1) throw new BadRequestException('authInfoLevel must be 0 or 1.');

  const contentFormats = value.contentFormats === undefined ? undefined : value.contentFormats;
  if (contentFormats !== undefined) {
    if (!Array.isArray(contentFormats) || contentFormats.length === 0 || contentFormats.length > 2) throw new BadRequestException("contentFormats must be an array containing 'text' and/or 'markdown'.");
    for (const format of contentFormats) {
      if (format !== 'text' && format !== 'markdown') throw new BadRequestException("contentFormats must contain only 'text' or 'markdown'.");
    }
  }

  const industry = value.industry === undefined ? undefined : value.industry;
  if (industry !== undefined && (typeof industry !== 'string' || !INDUSTRIES.includes(industry as (typeof INDUSTRIES)[number]))) {
    throw new BadRequestException(`industry must be one of: ${INDUSTRIES.join(', ')}.`);
  }

  const maxWaitTime = value.maxWaitTime === undefined ? undefined : value.maxWaitTime;
  if (maxWaitTime !== undefined && (typeof maxWaitTime !== 'number' || !Number.isInteger(maxWaitTime) || maxWaitTime < 1 || maxWaitTime > 30)) {
    throw new BadRequestException('maxWaitTime must be an integer number of seconds from 1 to 30.');
  }

  return {
    query,
    count,
    searchType,
    ...(typeof timeRange === 'string' ? { timeRange } : {}),
    ...(sites.length ? { sites } : {}),
    ...(blockHosts.length ? { blockHosts } : {}),
    ...(needContent === undefined ? {} : { needContent }),
    ...(needUrl === undefined ? {} : { needUrl }),
    ...(authInfoLevel === undefined ? {} : { authInfoLevel: authInfoLevel as 0 | 1 }),
    ...(icpHostOnly === undefined ? {} : { icpHostOnly }),
    ...(queryRewrite === undefined ? {} : { queryRewrite }),
    ...(contentFormats === undefined ? {} : { contentFormats: contentFormats as Array<'text' | 'markdown'> }),
    ...(industry === undefined ? {} : { industry: industry as (typeof INDUSTRIES)[number] }),
    ...(enableWaiting === undefined ? {} : { enableWaiting }),
    ...(maxWaitTime === undefined ? {} : { maxWaitTime }),
  };
}

function isTimeRange(value: string): boolean {
  if ((TIME_RANGES as readonly string[]).includes(value)) return true;
  const match = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (!match) return false;
  const from = validDate(match[1]!);
  const to = validDate(match[2]!);
  return from !== null && to !== null && from <= to;
}

function validDate(value: string): number | null {
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

function stringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new BadRequestException(`${field} must be an array of 1 to ${maxItems} strings.`);
  }
  const items = value.map((item) => (typeof item === 'string' ? item.trim() : ''));
  if (items.some((item) => !item || item.length > maxLength || /[\s|/?#]/.test(item))) {
    throw new BadRequestException(`${field} entries must be host names without whitespace, separators or paths, no longer than ${maxLength} characters.`);
  }
  return [...new Set(items)];
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new BadRequestException(`${field} must be a boolean.`);
  return value;
}

function mapResponse(params: VolcengineSearchParams, body: Record<string, unknown>, apiKey: string): WebSearchResponse {
  const result = objectOf(body.Result) ?? objectOf(body.result) ?? {};
  const rawItems = params.searchType === 'image'
    ? arrayOf(result.ImageResults) ?? arrayOf(result.imageResults) ?? arrayOf(result.WebResults) ?? arrayOf(result.webResults) ?? []
    : arrayOf(result.WebResults) ?? arrayOf(result.webResults) ?? [];
  const results: WebSearchItem[] = [];
  let omittedResults = 0;
  for (const rawItem of rawItems) {
    const item = objectOf(rawItem);
    if (!item) continue;
    const content = safeText(item.Content ?? item.content, apiKey);
    results.push({
      title: clip(safeText(item.Title ?? item.title, apiKey), 500) ?? '',
      url: clip(safeText(item.SourceUrl ?? item.PageUrl ?? item.Url ?? item.url ?? item.ImageUrl ?? item.imageUrl, apiKey), 2_000) ?? '',
      siteName: clip(safeText(item.SiteName ?? item.siteName, apiKey), 300),
      snippet: clip(safeText(item.Snippet ?? item.snippet, apiKey), SNIPPET_CHARS),
      summary: clip(safeText(item.Summary ?? item.summary, apiKey), SUMMARY_CHARS),
      publishTime: clip(safeText(item.PublishTime ?? item.publishTime, apiKey), 100),
      rankScore: numberOf(item.RankScore ?? item.rankScore),
      authInfoDes: clip(safeText(item.AuthInfoDes ?? item.authInfoDes, apiKey), 500),
      authInfoLevel: numberOf(item.AuthInfoLevel ?? item.authInfoLevel),
      content: params.needContent ? clip(content, CONTENT_CHARS) : null,
      contentTruncated: Boolean(params.needContent && content !== null && content.length > CONTENT_CHARS),
    });
  }
  // Bound the whole payload so one wide result set cannot exhaust the model context.
  const searchContext = clip(safeText(result.SearchContext ?? result.searchContext, apiKey), 2_000);
  const resultCount = numberOf(result.ResultCount ?? result.resultCount);
  const timeCostMs = numberOf(result.TimeCost ?? result.timeCost);
  const logId = clip(safeText(result.LogId ?? result.logId, apiKey), 200);
  let used = JSON.stringify({ query: params.query, resultCount, timeCostMs, logId, searchContext }).length;
  let kept = 0;
  for (const item of results) {
    const size = JSON.stringify(item).length;
    if (kept > 0 && used + size > MAX_OUTPUT_CHARS) { omittedResults = results.length - kept; break; }
    used += size;
    kept += 1;
  }
  const bounded = results.slice(0, kept);
  return {
    query: params.query,
    resultCount,
    timeCostMs,
    logId,
    searchContext,
    results: bounded,
    omittedResults,
    truncated: omittedResults > 0,
    note: omittedResults > 0
      ? `${omittedResults} lower-ranked result(s) were omitted to keep the response bounded. Narrow the query or lower count instead of requesting everything.`
      : null,
  };
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayOf(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeText(value: unknown, apiKey: string): string | null {
  const text = textOf(value);
  return text === null ? null : sanitize(text, apiKey);
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clip(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

async function readUpstreamResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_UPSTREAM_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ServiceUnavailableException('Volcengine web search returned a response larger than the allowed limit. Reduce the result count or disable NeedContent.');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ServiceUnavailableException) throw error;
    throw new ServiceUnavailableException('Volcengine web search failed: the response timed out or was interrupted.');
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function errorCodeOf(body: unknown): string | null {
  const value = objectOf(body);
  if (!value) return null;
  const metadata = objectOf(value.ResponseMetadata);
  const metadataError = metadata ? objectOf(metadata.Error) : null;
  const candidates: unknown[] = [
    value.code,
    value.Code,
    objectOf(value.error)?.code,
    objectOf(value.Error)?.code,
    metadataError?.Code,
    objectOf(value.Result)?.code,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate === 0 ? null : String(candidate);
    if (typeof candidate === 'string' && /^\d+$/.test(candidate.trim())) {
      const code = candidate.trim();
      if (code !== '0') return code;
    }
  }
  return null;
}

function upstreamMessage(body: unknown): string | null {
  const value = objectOf(body);
  if (!value) return null;
  const metadataError = objectOf(objectOf(value.ResponseMetadata)?.Error);
  for (const candidate of [value.message, value.Message, value.msg, objectOf(value.error)?.message, metadataError?.Message, metadataError?.message]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function errorMessage(code: string, message: string | null, apiKey: string): string {
  const known = ERROR_MESSAGES[code];
  if (known) return `${known} (code ${code})`;
  const detail = message ? `: ${sanitize(message, apiKey)}` : '';
  return `Volcengine web search failed (code ${code})${detail}`;
}

// Upstream text is evidence, not a trusted label; never let it carry the key back.
function sanitize(value: string, apiKey: string): string {
  return value.split(apiKey).join('[redacted]');
}
