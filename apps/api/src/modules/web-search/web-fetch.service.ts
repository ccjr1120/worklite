import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2_000_000;
const DEFAULT_MAX_CHARS = 8_000;
const MIN_MAX_CHARS = 500;
const MAX_MAX_CHARS = 20_000;
const TEXT_MEDIA_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain', 'text/xml', 'application/xml']);
type HttpAgentOptions = ConstructorParameters<typeof HttpAgent>[0];
type PinnedLookup = NonNullable<Exclude<HttpAgentOptions, undefined>['lookup']>;
type ResolvedAddress = { address: string; family: number };

export type WebFetchResponse = {
  url: string;
  finalUrl: string;
  title: string;
  contentType: string;
  bytes: number;
  text: string;
  truncated: boolean;
  note: string | null;
};

@Injectable()
export class WebFetchService {
  /**
   * Fetches one public web page and returns its readable text. The request only
   * leaves the host for http(s) URLs whose resolved addresses are public.
   */
  async fetchPage(raw: unknown): Promise<WebFetchResponse> {
    const { url, maxChars } = normalizeFetchInput(raw);
    const fetched = await requestFollowingRedirects(url);
    try {
      const header = fetched.response.headers['content-type'];
      const contentType = Array.isArray(header) ? header[0] ?? '' : header ?? '';
      const mediaType = contentType.split(';')[0]!.trim().toLowerCase();
      if (mediaType && !TEXT_MEDIA_TYPES.has(mediaType)) {
        fetched.response.destroy();
        throw new ServiceUnavailableException(`Unsupported page content type: ${mediaType}. Only HTML and plain text pages can be fetched.`);
      }
      const { bytes, text: rawBody, bodyTruncated } = await readBoundedBody(fetched.response);
      const decoded = decodeBody(rawBody, contentType, mediaType === 'text/html' || mediaType === 'application/xhtml+xml');
      const isHtml = mediaType === 'text/html' || mediaType === 'application/xhtml+xml' || (mediaType === '' && /<html[\s>]/i.test(decoded.slice(0, 2_000)));
      const title = isHtml ? extractTitle(decoded) : '';
      const text = isHtml ? extractText(decoded) : decoded.trim();
      const clipped = text.length > maxChars;
      const finalText = clipped ? `${text.slice(0, maxChars - 1)}…` : text;
      const notes: string[] = [];
      if (bodyTruncated) notes.push(`The page body exceeded ${MAX_BODY_BYTES} bytes; only its beginning was read.`);
      if (clipped) notes.push(`The extracted text exceeded maxChars (${maxChars}) and was truncated.`);
      return {
        url,
        finalUrl: fetched.finalUrl,
        title,
        contentType: mediaType || 'unknown',
        bytes,
        text: finalText,
        truncated: bodyTruncated || clipped,
        note: notes.length ? notes.join(' ') : null,
      };
    } finally {
      fetched.agent.destroy();
    }
  }
}

function normalizeFetchInput(raw: unknown): { url: string; maxChars: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Web fetch input must be an object.');
  const value = raw as Record<string, unknown>;
  if (typeof value.url !== 'string' || !value.url.trim()) throw new BadRequestException('url is required.');
  if (value.url.length > 2_000) throw new BadRequestException('url must be no longer than 2000 characters.');
  const maxChars = value.maxChars === undefined ? DEFAULT_MAX_CHARS : value.maxChars;
  if (typeof maxChars !== 'number' || !Number.isInteger(maxChars) || maxChars < MIN_MAX_CHARS || maxChars > MAX_MAX_CHARS) {
    throw new BadRequestException(`maxChars must be an integer from ${MIN_MAX_CHARS} to ${MAX_MAX_CHARS}.`);
  }
  return { url: value.url.trim(), maxChars };
}

async function requestFollowingRedirects(start: string): Promise<{ response: IncomingMessage; finalUrl: string; agent: HttpAgent | HttpsAgent }> {
  let current = parseUrl(start);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const addresses = await resolvePublicTarget(current);
    const lookup = pinnedLookup(addresses);
    const agent = current.protocol === 'https:'
      ? new HttpsAgent({ keepAlive: false, lookup })
      : new HttpAgent({ keepAlive: false, lookup });
    let response: IncomingMessage;
    try {
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        const requestOptions = {
          method: 'GET',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            'user-agent': 'WorkLite/1.0 (+web fetch)',
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
            'accept-encoding': 'identity',
          },
        };
        const outgoing = current.protocol === 'https:'
          ? httpsRequest(current, { ...requestOptions, agent: agent as HttpsAgent }, resolve)
          : httpRequest(current, { ...requestOptions, agent: agent as HttpAgent }, resolve);
        outgoing.once('error', reject);
        outgoing.end();
      });
    } catch (error) {
      agent.destroy();
      const reason = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'the request timed out' : 'the page is unreachable';
      throw new ServiceUnavailableException(`Web fetch failed for ${current.hostname}: ${reason}.`);
    }
    if (isRedirect(response.statusCode ?? 0)) {
      const location = response.headers.location;
      response.destroy();
      agent.destroy();
      if (!location) throw new ServiceUnavailableException(`Web fetch failed for ${current.hostname}: HTTP ${response.statusCode} without a Location header.`);
      if (hop === MAX_REDIRECTS) throw new ServiceUnavailableException(`Web fetch exceeded ${MAX_REDIRECTS} redirects.`);
      try {
        current = parseUrl(new URL(location, current).toString());
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        throw new ServiceUnavailableException('Web fetch received an invalid redirect URL.');
      }
      continue;
    }
    if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
      response.destroy();
      agent.destroy();
      throw new ServiceUnavailableException(`Web fetch failed for ${current.hostname}: HTTP ${response.statusCode}.`);
    }
    return { response, finalUrl: current.toString(), agent };
  }
  throw new ServiceUnavailableException(`Web fetch exceeded ${MAX_REDIRECTS} redirects.`);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function parseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new BadRequestException('url must be an absolute http or https URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BadRequestException('Only http and https URLs can be fetched.');
  if (url.username || url.password) throw new BadRequestException('URLs with embedded credentials are not allowed.');
  if (!url.hostname) throw new BadRequestException('url must name a host.');
  return url;
}

async function resolvePublicTarget(url: URL): Promise<ResolvedAddress[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!hostname) throw new BadRequestException('url must name a host.');
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new BadRequestException('url points to a private, loopback or link-local address, which is not allowed.');
    return [{ address: hostname, family: isIP(hostname) }];
  }
  // Single-label and reserved local suffixes resolve inside the host network.
  if (!hostname.includes('.') || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa') || hostname.endsWith('.lan')) {
    throw new BadRequestException('url points to a local host name, which is not allowed.');
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await withTimeout(lookup(hostname, { all: true, verbatim: true }), REQUEST_TIMEOUT_MS);
  } catch {
    throw new ServiceUnavailableException(`Web fetch failed: the host ${hostname} could not be resolved.`);
  }
  if (addresses.length === 0) throw new ServiceUnavailableException(`Web fetch failed: the host ${hostname} could not be resolved.`);
  if (addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new BadRequestException('url resolves to a private, loopback or link-local address, which is not allowed.');
  }
  return addresses;
}

async function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('Operation timed out.')), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pinnedLookup(addresses: ResolvedAddress[]): PinnedLookup {
  return (_hostname, options, callback) => {
    const family = typeof options === 'number' ? options : options.family;
    const candidates = family ? addresses.filter((entry) => entry.family === family) : addresses;
    if (typeof options !== 'number' && options.all) {
      callback(null, candidates);
      return;
    }
    const address = candidates[0];
    if (!address) {
      const error = Object.assign(new Error('No verified address is available for this host.'), { code: 'ENOTFOUND' });
      callback(error, '', 0);
      return;
    }
    callback(null, address.address, address.family);
  };
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(raw: string): boolean {
  const value = parseIpv6(raw);
  if (value === null) return false;
  const ipv4Mapped = value >> 32n;
  if (ipv4Mapped === 0xffffn) {
    const ipv4 = Number(value & 0xffff_ffffn);
    return isPublicIpv4(`${ipv4 >>> 24}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`);
  }
  // Only accept global-unicast addresses. This excludes loopback, ULA, link-local,
  // multicast, NAT64 and other special-purpose ranges before connecting.
  if ((value >> 125n) !== 1n) return false;
  if (hasIpv6Prefix(value, '2001::', 23) || hasIpv6Prefix(value, '2001:db8::', 32) || hasIpv6Prefix(value, '2002::', 16) || hasIpv6Prefix(value, '3fff::', 20)) return false;
  return true;
}

function parseIpv6(raw: string): bigint | null {
  let address = raw.toLowerCase().replace(/^\[|\]$/g, '');
  if (address.includes('.')) {
    const separator = address.lastIndexOf(':');
    const ipv4 = address.slice(separator + 1);
    if (separator < 0 || isIP(ipv4) !== 4) return null;
    const octets = ipv4.split('.').map(Number);
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    address = `${address.slice(0, separator)}:${high}:${low}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const zeroCount = 8 - left.length - right.length;
  if ((halves.length === 1 && zeroCount !== 0) || (halves.length === 2 && zeroCount < 1)) return null;
  const groups = [...left, ...Array.from({ length: zeroCount }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function hasIpv6Prefix(address: bigint, prefix: string, bits: number): boolean {
  const prefixValue = parseIpv6(prefix);
  if (prefixValue === null) return false;
  const shift = BigInt(128 - bits);
  return (address >> shift) === (prefixValue >> shift);
}

async function readBoundedBody(response: IncomingMessage): Promise<{ bytes: number; text: Buffer; bodyTruncated: boolean }> {
  const reader = Readable.toWeb(response).getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let bodyTruncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = MAX_BODY_BYTES - bytes;
      if (value.byteLength > remaining) {
        chunks.push(Buffer.from(value.subarray(0, remaining)));
        bytes += remaining;
        bodyTruncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(Buffer.from(value));
      bytes += value.byteLength;
    }
  } catch {
    throw new ServiceUnavailableException('Web fetch failed while reading the page body; it may have timed out or been interrupted.');
  }
  return { bytes, text: Buffer.concat(chunks), bodyTruncated };
}

function decodeBody(body: Buffer, contentType: string, isHtml: boolean): string {
  let charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset && isHtml) {
    // Sniff the declared meta charset before decoding so GBK pages remain readable.
    charset = /charset\s*=\s*["']?([\w-]+)/i.exec(body.subarray(0, 2_048).toString('latin1'))?.[1];
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return normalizeInline(decodeEntities(match?.[1] ?? heading?.[1] ?? ''));
}

function extractText(html: string): string {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const withoutHidden = withoutComments.replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed|head)[\s\S]*?<\/\1>/gi, ' ');
  // Prefer the semantic main region when the page provides one with real content.
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(withoutHidden)?.[1];
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(withoutHidden)?.[1];
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(withoutHidden)?.[1];
  const candidate = article && article.length > 500 ? article : main && main.length > 500 ? main : body ?? withoutHidden;
  const withBreaks = candidate
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|table|ul|ol|nav|aside|main|dd|dt|figcaption)>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped)
    .split('\n')
    .map((line) => normalizeInline(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeInline(value: string): string {
  return value.replace(/[\t  ]+/g, ' ').trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => safeCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function safeCodePoint(value: number): string {
  try { return Number.isFinite(value) ? String.fromCodePoint(value) : ''; } catch { return ''; }
}
