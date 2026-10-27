import type { ArtifactInlineImageView } from '@worklite/contracts';

export const ARTIFACT_IMAGE_PLACEHOLDER = /!\[([^\]]*)\]\(\s*worklite-image:([^)\s]+)\s*\)/g;

const MARKDOWN_IMAGE_URL = /!\[([^\]]*)\]\(\s*(https?:\/\/[^)\s]+)\s*\)/g;
const URL_MAP_FIELDS = new Set(['inlineImageUrls', 'workliteImageUrls', 'imageUrls', 'artifactImageUrls']);
const HTTP_URL = /^https?:\/\//i;

type Placeholder = { key: string; alt: string };
export type ArtifactImageReference = { key: string | null; position: number | null; url: string | null };

/** Unique placeholder keys in document order; the first alt text wins. */
export function findArtifactImagePlaceholders(content: string): Placeholder[] {
  const seen = new Set<string>();
  const placeholders: Placeholder[] = [];
  for (const match of content.matchAll(ARTIFACT_IMAGE_PLACEHOLDER)) {
    const key = match[2] ?? '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    placeholders.push({ key, alt: match[1] ?? '' });
  }
  return placeholders;
}

/**
 * Run records normally retain only sanitized image summaries; the uploaded
 * WeChat material URLs never leave the publishing session. This walk still
 * picks up a real URL when an upstream node or a future run view exposes one.
 */
export function resolveArtifactInlineImages(
  content: string,
  runRecords: readonly unknown[],
  imageArtifacts: readonly ArtifactImageReference[] = [],
): ArtifactInlineImageView[] {
  const placeholders = findArtifactImagePlaceholders(content);
  if (placeholders.length === 0) return [];
  const keys = new Set(placeholders.map((placeholder) => placeholder.key));
  const urls = new Map<string, string>();
  const visited = new WeakSet<object>();
  for (const record of runRecords) collectImageUrls(record, keys, urls, visited);
  const imageUrlsByKey = new Map<string, string>();
  const ambiguousKeys = new Set<string>();
  const imageUrlsByPosition = new Map<number, string>();
  const ambiguousPositions = new Set<number>();
  for (const image of imageArtifacts) {
    if (!image.url || !ARTIFACT_CONTENT_URL.test(image.url)) continue;
    if (image.key) addUniqueImageReference(imageUrlsByKey, ambiguousKeys, image.key, image.url);
    if (Number.isInteger(image.position) && image.position! > 0) addUniqueImageReference(imageUrlsByPosition, ambiguousPositions, image.position!, image.url);
  }
  return placeholders.map((placeholder) => ({
    ...placeholder,
    url: urls.get(placeholder.key)
      ?? urls.get(placeholder.alt)
      ?? resolveImageArtifactUrl(placeholder.key, imageUrlsByKey, ambiguousKeys, imageUrlsByPosition, ambiguousPositions),
  }));
}

const ARTIFACT_CONTENT_URL = /^\/api\/artifacts\/art_[A-Za-z0-9-]+\/content$/;

function addUniqueImageReference<Key extends string | number>(
  references: Map<Key, string>,
  ambiguous: Set<Key>,
  key: Key,
  url: string,
): void {
  if (ambiguous.has(key)) return;
  const existing = references.get(key);
  if (existing && existing !== url) {
    references.delete(key);
    ambiguous.add(key);
    return;
  }
  references.set(key, url);
}

function resolveImageArtifactUrl(
  key: string,
  byKey: ReadonlyMap<string, string>,
  ambiguousKeys: ReadonlySet<string>,
  byPosition: ReadonlyMap<number, string>,
  ambiguousPositions: ReadonlySet<number>,
): string | null {
  if (ambiguousKeys.has(key)) return null;
  const exact = byKey.get(key);
  if (exact) return exact;
  if (!/^[1-9]\d*$/.test(key)) return null;
  const position = Number(key);
  return ambiguousPositions.has(position) ? null : byPosition.get(position) ?? null;
}

function collectImageUrls(value: unknown, keys: ReadonlySet<string>, urls: Map<string, string>, visited: WeakSet<object>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(MARKDOWN_IMAGE_URL)) {
      const alt = match[1] ?? '';
      const url = match[2] ?? '';
      // Article alt text is the readable link between a placeholder and a resolved image.
      if (alt && HTTP_URL.test(url)) urls.set(alt, url);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (visited.has(value)) return;
  visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectImageUrls(item, keys, urls, visited);
    return;
  }

  for (const [field, child] of Object.entries(value as Record<string, unknown>)) {
    if (URL_MAP_FIELDS.has(field) && child && typeof child === 'object' && !Array.isArray(child)) {
      for (const [key, url] of Object.entries(child as Record<string, unknown>)) {
        if (keys.has(key) && typeof url === 'string' && HTTP_URL.test(url)) urls.set(key, url);
      }
    }
    if (keys.has(field) && typeof child === 'string' && HTTP_URL.test(child)) urls.set(field, child);
    collectImageUrls(child, keys, urls, visited);
  }
}
