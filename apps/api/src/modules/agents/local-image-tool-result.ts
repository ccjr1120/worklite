import type { LocalImageArtifactView } from '@worklite/contracts';

const IMAGE_FIELDS = ['id', 'name', 'mimeType', 'sizeBytes', 'width', 'height', 'contentUrl', 'markdown'];
const MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const onlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
const integer = (value: unknown, maximum: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maximum;

/**
 * upload_local_images has a data contract, not a UI-action contract. Decode its
 * transport envelope first, validate the exact API result, then expose only that
 * result. Diagnostic evidence stays in the original Command stdout for failures.
 * No other protected tool is admitted through this path.
 */
export function localImageToolOutput(stdout: string): string | null {
  let wire: Record<string, unknown> | null;
  try { wire = record(JSON.parse(stdout)); } catch { return null; }
  if (!wire) return null;
  let payload = wire;
  if ('worklite' in wire || 'data' in wire) {
    // Older captured packages can still emit the standard snapshot envelope.
    // It is transport metadata, never the upload tool's model-facing result.
    const metadata = record(wire.worklite);
    if (!onlyKeys(wire, ['worklite', 'data', 'workliteEvidence']) || !metadata || !onlyKeys(metadata, ['type']) || metadata.type !== 'snapshot') return null;
    const data = record(wire.data);
    if (!data || !onlyKeys(data, ['images'])) return null;
    payload = data;
  } else if (!onlyKeys(wire, ['images', 'workliteEvidence'])) return null;
  const images = payload.images;
  if (!Array.isArray(images) || images.length < 1 || images.length > 8) return null;
  const ids = new Set<string>();
  let bytes = 0;
  for (const value of images) {
    const image = record(value);
    if (!image || Object.keys(image).length !== IMAGE_FIELDS.length || !onlyKeys(image, IMAGE_FIELDS)) return null;
    if (typeof image.id !== 'string' || !/^art_[A-Za-z0-9-]+$/.test(image.id) || ids.has(image.id)) return null;
    ids.add(image.id);
    if (typeof image.name !== 'string' || !image.name.trim() || image.name.length > 200 || /[\/\\\x00-\x1f\x7f\u2028\u2029]/.test(image.name)) return null;
    if (typeof image.mimeType !== 'string' || !MIME_TYPES.includes(image.mimeType) || !integer(image.sizeBytes, 10 * 1024 * 1024)) return null;
    if (!integer(image.width, 16384) || !integer(image.height, 16384) || image.width * image.height > 40_000_000) return null;
    bytes += image.sizeBytes;
    if (bytes > 40 * 1024 * 1024) return null;
    const url = `/api/artifacts/${image.id}/content`;
    const alt = image.name.replace(/[\[\]\\()<>`*_!]/g, ' ').trim();
    if (image.contentUrl !== url || image.markdown !== `![${alt}](${url})`) return null;
  }
  // This is the entire public result. Do not leak evidence or re-wrap it in worklite/data.
  return JSON.stringify({ images: images as LocalImageArtifactView[] });
}
