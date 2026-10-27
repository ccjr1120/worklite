import { chatAttachmentImagePattern, type ModelProviderProtocol } from '@worklite/contracts';
import type { GatewayAgentMessage, GatewayUserContentPart } from '@worklite/model-gateway';

/**
 * Per-image ceiling for inlining. The attachment store accepts up to 10 MB, but the Anthropic
 * Messages API rejects a single image above 5 MB, so the smallest upstream limit is the one that
 * decides: 3.5 MiB of bytes is still under 5 MB once base64 expands it. A larger image keeps its
 * Markdown reference instead of failing the request.
 */
export const MAX_INLINE_IMAGE_BYTES = 3.5 * 1024 * 1024;
/** Request-wide ceilings, so a conversation full of pasted images cannot grow one request without bound. */
export const MAX_INLINE_IMAGES = 8;
const MAX_INLINE_IMAGE_BYTES_TOTAL = 10 * 1024 * 1024;

/**
 * Whether a Provider protocol carries image content blocks to its upstream. The four protocols an
 * Agent step can run on all do, and the WorkLite Gateway forwards their message/input arrays
 * verbatim, so the only protocol without image input is System One — which a conversation cannot
 * use anyway. Model-level support is a separate matter: a text-only model behind one of these
 * protocols answers with its own provider error.
 */
export function protocolAcceptsImageInput(protocol: ModelProviderProtocol): boolean {
  switch (protocol) {
    case 'anthropic/messages':
    case 'openai/chat':
    case 'openai/responses':
    case 'codex/responses':
      return true;
    case 'typesafe/systemone':
      return false;
  }
}

export type ChatAttachmentImageStore = {
  describe(id: string): { mimeType: string; size: number; projectTaskId: string | null } | null;
  load(id: string): Promise<{ mimeType: string; body: Buffer } | null>;
};

type InlineImageSkip = { id: string; reason: 'too_large' | 'request_budget' | 'protocol' };

type InlineImagesResult = {
  messages: GatewayAgentMessage[];
  inlined: number;
  skipped: InlineImageSkip[];
};

/**
 * Replaces the user's own attachment images with real image content blocks, so the conversation
 * model sees the pixels instead of a URL it cannot fetch.
 *
 * Only images the user uploaded themselves are inlined. An image an executor produced for a task
 * report carries that task's id and stays a Markdown reference, because a report image belongs to
 * the channel that renders it, not to the model's context. A reference whose record is gone —
 * expired or deleted — also stays as written: its origin is no longer knowable, and leaving the
 * text intact is what lets one dead image degrade without touching the rest of the message.
 *
 * Inlining happens per request and is never stored: the conversation keeps its Markdown references,
 * so a later turn re-reads whatever is still live.
 */
export async function inlineUserAttachmentImages(
  messages: readonly GatewayAgentMessage[],
  options: { protocol: ModelProviderProtocol; store: ChatAttachmentImageStore },
): Promise<InlineImagesResult> {
  const candidates = messages.flatMap((message) => userImageIds(message));
  if (candidates.length === 0) return { messages: [...messages], inlined: 0, skipped: [] };
  if (!protocolAcceptsImageInput(options.protocol)) {
    const seen = new Set<string>();
    const skipped = candidates.flatMap((id) => {
      if (seen.has(id)) return [];
      seen.add(id);
      const described = options.store.describe(id);
      return described && !described.projectTaskId ? [{ id, reason: 'protocol' as const }] : [];
    });
    return { messages: [...messages], inlined: 0, skipped };
  }

  const loaded = new Map<string, GatewayUserContentPart>();
  const skipped: InlineImageSkip[] = [];
  const examined = new Set<string>();
  let budget = MAX_INLINE_IMAGE_BYTES_TOTAL;
  for (const id of candidates) {
    if (examined.has(id)) continue;
    examined.add(id);
    const described = options.store.describe(id);
    // No record, or an executor's own report image: not an image the user handed to the model.
    if (!described || described.projectTaskId) continue;
    if (described.size > MAX_INLINE_IMAGE_BYTES) { skipped.push({ id, reason: 'too_large' }); continue; }
    if (loaded.size >= MAX_INLINE_IMAGES || described.size > budget) { skipped.push({ id, reason: 'request_budget' }); continue; }
    const file = await options.store.load(id);
    if (!file) continue;
    budget -= file.body.length;
    loaded.set(id, { type: 'image', image: file.body.toString('base64'), mediaType: file.mimeType });
  }
  if (loaded.size === 0) return { messages: [...messages], inlined: 0, skipped };

  const expanded: GatewayAgentMessage[] = [];
  for (const message of messages) {
    const references = userImageIds(message).filter((id) => loaded.has(id));
    if (references.length === 0) { expanded.push(message); continue; }
    const parts = [...new Set(references)].map((id) => loaded.get(id)!);
    if (message.role === 'user') {
      const text = typeof message.content === 'string' ? withoutImageReferences(message.content, loaded) : '';
      expanded.push({ role: 'user', content: [...(text ? [{ type: 'text' as const, text }] : []), ...parts] });
      continue;
    }
    if (message.role !== 'tool') { expanded.push(message); continue; }
    // A clarification answer reaches the model as the ask_user tool's result, which carries text
    // only. The answer's images follow it as their own user message; every protocol accepts that,
    // and the Anthropic adapter merges the pair back into one user turn with the tool result first.
    expanded.push({
      role: 'tool',
      content: message.content.map((part) => part.toolName === 'ask_user'
        ? { ...part, output: { ...part.output, value: withoutImageReferences(part.output.value, loaded) || '（用户以图片作答。）' } }
        : part),
    });
    expanded.push({ role: 'user', content: [{ type: 'text', text: '以下是用户随上一条回答附带的图片。' }, ...parts] });
  }
  return { messages: expanded, inlined: loaded.size, skipped };
}

/**
 * The attachment images in one message that could be the user's own. A user message is the user's
 * text; a tool message qualifies only for ask_user, whose result is the answer the user typed.
 * Every other tool result is machine output, including a project task report.
 */
function userImageIds(message: GatewayAgentMessage): string[] {
  if (message.role === 'user') return typeof message.content === 'string' ? imageIds(message.content) : [];
  if (message.role !== 'tool') return [];
  return message.content.flatMap((part) => part.toolName === 'ask_user' ? imageIds(part.output.value) : []);
}

function imageIds(text: string): string[] {
  return Array.from(text.matchAll(chatAttachmentImagePattern()), (match) => match[2]!);
}

/** Drops the references that became image blocks, leaving every other reference as written. */
function withoutImageReferences(text: string, inlined: ReadonlyMap<string, unknown>): string {
  return text
    .replace(chatAttachmentImagePattern(), (match, _alt: string, id: string) => inlined.has(id) ? '' : match)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
