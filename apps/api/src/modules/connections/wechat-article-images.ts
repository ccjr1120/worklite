export type GeneratedInlineImage = {
  key?: string;
  b64Json: string;
};

export type InlineImageReference = {
  key: string;
  alt: string;
  raw: string;
};

export type InlineImageUpload = {
  uploadKey: string;
  b64Json: string;
};

export type InlineImagePlan = {
  uploads: InlineImageUpload[];
  placeholderUploadKeys: Map<string, string>;
};

// The article Markdown decides where an illustration appears and how many
// there are. An image placeholder keeps ordinary Markdown image syntax, so the
// approved-article node and the Markdown renderer need no special case.
export const INLINE_IMAGE_PLACEHOLDER = /!\[([^\]]*)\]\(\s*worklite-image:([^)\s]+)\s*\)/g;

export function findInlineImageReferences(markdown: string): InlineImageReference[] {
  const references: InlineImageReference[] = [];
  for (const match of markdown.matchAll(INLINE_IMAGE_PLACEHOLDER)) {
    references.push({ alt: match[1] ?? '', key: match[2] ?? '', raw: match[0] });
  }
  return references;
}

export function validateGeneratedInlineImages(value: unknown): GeneratedInlineImage[] {
  if (value === undefined || value === null) return [];
  // A multiple input port arrives as an array of committed values, so an array
  // map's ordered output reaches this node as one nested array. Flatten exactly
  // one level; deeper nesting would mean the author connected the wrong graph.
  const entries = Array.isArray(value) ? value.flatMap((entry) => (Array.isArray(entry) ? entry : [entry])) : [value];
  const images: GeneratedInlineImage[] = [];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`WeChat Official Account inline image ${index + 1} is not a generated image output.`);
    const record = entry as Record<string, unknown>;
    if (record.type !== 'workflow_image' || record.mediaType !== 'image/png' || !Array.isArray(record.data) || record.data.length === 0) {
      throw new Error(`WeChat Official Account inline image ${index + 1} is not a generated PNG image.`);
    }
    const data = record.data as unknown[];
    let key: string | undefined;
    if (record.key !== undefined) {
      if (typeof record.key !== 'string' || !record.key.trim()) throw new Error(`WeChat Official Account inline image ${index + 1} has an invalid key.`);
      key = record.key.trim();
    }
    data.forEach((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof (item as Record<string, unknown>).b64Json !== 'string' || !(item as Record<string, unknown>).b64Json) {
        throw new Error(`WeChat Official Account inline image ${index + 1} is missing PNG data.`);
      }
      // worklite/image@1 can return several PNGs in one output record. Each
      // becomes its own illustration; an explicit key only identifies one image.
      images.push({
        ...(data.length === 1 && key ? { key } : {}),
        b64Json: (item as { b64Json: string }).b64Json,
      });
    });
  });
  return images;
}

function imageByKey(images: GeneratedInlineImage[]): Map<string, GeneratedInlineImage> {
  const byKey = new Map<string, GeneratedInlineImage>();
  images.forEach((image, index) => {
    // A positional key makes a single generated image usable without extra
    // configuration. Explicit keys are applied afterwards so they win on a
    // collision with a numeric position.
    byKey.set(String(index + 1), image);
  });
  images.forEach((image) => {
    if (image.key) byKey.set(image.key, image);
  });
  return byKey;
}

/**
 * Resolves the article's placeholders against the generated images that
 * arrived on the node's images input. Returns one upload per distinct image,
 * in article order, and fails with a readable message for a dangling key.
 */
export function planInlineImageUploads(markdown: string, images: GeneratedInlineImage[]): InlineImagePlan {
  const references = findInlineImageReferences(markdown);
  const plan: InlineImagePlan = { uploads: [], placeholderUploadKeys: new Map() };
  if (references.length === 0) return plan;
  const byKey = imageByKey(images);
  const provided = [...byKey.keys()].sort();
  const uploads = new Map<string, InlineImageUpload>();
  for (const reference of references) {
    const image = byKey.get(reference.key);
    if (!image) {
      throw new Error(`The article references inline image "${reference.key}", but no generated image with that key was provided. Available keys: ${provided.join(', ') || 'none'}.`);
    }
    const uploadKey = image.key ?? `position-${images.indexOf(image) + 1}`;
    if (!uploads.has(uploadKey)) uploads.set(uploadKey, { uploadKey, b64Json: image.b64Json });
    plan.placeholderUploadKeys.set(reference.key, uploadKey);
  }
  plan.uploads = [...uploads.values()];
  return plan;
}

/** Replaces every placeholder with the uploaded WeChat material URL. */
export function applyInlineImageUrls(markdown: string, plan: InlineImagePlan, urlsByUploadKey: ReadonlyMap<string, string>): string {
  return markdown.replace(INLINE_IMAGE_PLACEHOLDER, (raw, alt: string, key: string) => {
    const uploadKey = plan.placeholderUploadKeys.get(key);
    const url = uploadKey ? urlsByUploadKey.get(uploadKey) : undefined;
    if (!url) throw new Error(`The uploaded URL for inline image "${key}" is unavailable.`);
    return `![${alt}](${url})`;
  });
}
