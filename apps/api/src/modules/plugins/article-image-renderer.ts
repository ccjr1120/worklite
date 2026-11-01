import { chromium } from 'playwright';

export type ArticleImageIssueKind = 'clipped' | 'overflow' | 'overlap' | 'covered' | 'duplicate' | 'small_text';

export type ArticleImageIssue = {
  kind: ArticleImageIssueKind;
  text: string;
  detail: string;
};

export type ArticleImageRender = {
  png: Buffer;
  width: number;
  height: number;
  issues: ArticleImageIssue[];
};

type Rect = { left: number; top: number; right: number; bottom: number };

/** One visible text node as laid out by the browser. */
export type LaidOutText = {
  id: number;
  text: string;
  /** Text of its nearest block container, used to find repeated labels. */
  blockId: number;
  blockText: string;
  fontSize: number;
  lines: Rect[];
  /** Border box of its nearest block container. */
  container: Rect;
  /** Boxes of ancestors that hide their overflow. */
  clips: Rect[];
  /** Whether the topmost element at each line's centre is this text's own element. */
  coveredLines: number;
};

export const ARTICLE_IMAGE_MIN_WIDTH = 1080;
export const ARTICLE_IMAGE_MIN_HEIGHT = 720;
export const ARTICLE_IMAGE_MAX_EDGE = 2160;
export const ARTICLE_IMAGE_MAX_HTML = 100_000;
const MIN_FONT_PX_AT_1080 = 20;
const RENDER_TIMEOUT_MS = 30_000;
const TOLERANCE_PX = 2;

const BASE_STYLE = [
  'html,body{margin:0;padding:0;overflow:hidden;}',
  'body{font-family:"PingFang SC","Hiragino Sans GB","Heiti SC","Noto Sans CJK SC",sans-serif;-webkit-font-smoothing:antialiased;}',
].join('');

export function validateArticleImageInput(value: { html?: unknown; width?: unknown; height?: unknown }): { html: string; width: number; height: number } {
  const width = value.width === undefined ? ARTICLE_IMAGE_MIN_WIDTH : value.width;
  const height = value.height === undefined ? ARTICLE_IMAGE_MIN_HEIGHT : value.height;
  if (typeof width !== 'number' || !Number.isInteger(width) || width < ARTICLE_IMAGE_MIN_WIDTH || width > ARTICLE_IMAGE_MAX_EDGE) {
    throw new Error(`width must be an integer from ${ARTICLE_IMAGE_MIN_WIDTH} to ${ARTICLE_IMAGE_MAX_EDGE}.`);
  }
  if (typeof height !== 'number' || !Number.isInteger(height) || height < ARTICLE_IMAGE_MIN_HEIGHT || height > ARTICLE_IMAGE_MAX_EDGE) {
    throw new Error(`height must be an integer from ${ARTICLE_IMAGE_MIN_HEIGHT} to ${ARTICLE_IMAGE_MAX_EDGE}.`);
  }
  if (typeof value.html !== 'string' || !value.html.trim()) throw new Error('html must be a non-empty HTML document or fragment.');
  if (value.html.length > ARTICLE_IMAGE_MAX_HTML) throw new Error(`html must not exceed ${ARTICLE_IMAGE_MAX_HTML} characters.`);
  return { html: value.html, width, height };
}

/**
 * Renders an illustration written as HTML and CSS, then reports layout
 * problems a reader would see. The page runs with JavaScript disabled and
 * every network request refused, so the markup can only describe layout:
 * images and fonts must be inline (data: URIs) or system fonts.
 */
export async function renderArticleImage(input: { html: string; width: number; height: number }): Promise<ArticleImageRender> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: input.width, height: input.height },
      deviceScaleFactor: 1,
      offline: true,
    });
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);
    await page.setContent(articleImageDocument(input.html, input.width, input.height), { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
    const texts = await page.evaluate<LaidOutText[]>(COLLECT_LAID_OUT_TEXT);
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: input.width, height: input.height }, timeout: RENDER_TIMEOUT_MS });
    return { png, width: input.width, height: input.height, issues: findLayoutIssues(texts, input.width, input.height) };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export function articleImageDocument(html: string, width: number, height: number): string {
  const size = `html,body{width:${width}px;height:${height}px;}`;
  if (/<html[\s>]/i.test(html)) {
    // A full document keeps its own head; the base reset still goes first so
    // the author's styles override it.
    return html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}<meta charset="utf-8"><style>${BASE_STYLE}${size}</style>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_STYLE}${size}</style></head><body>${html}</body></html>`;
}

// Runs inside the page through evaluate, which works with page scripts
// disabled. It is plain JavaScript text so no bundler helper leaks into it.
const COLLECT_LAID_OUT_TEXT = String.raw`(() => {
  const view = document.defaultView;
  const toRect = (rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  // An <svg> is the box its own labels belong to, even though it lays out inline.
  const isInline = (element) => {
    if (element instanceof SVGSVGElement) return false;
    if (element instanceof SVGElement) return true;
    return view.getComputedStyle(element).display.startsWith('inline');
  };
  const blockOf = (element) => {
    let current = element;
    while (current.parentElement && current !== document.body && isInline(current)) current = current.parentElement;
    return current;
  };
  const visible = (element) => {
    for (let current = element; current; current = current.parentElement) {
      const style = view.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const blocks = new Map();
  const result = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    const element = node.parentElement;
    if (!text || !element || element.closest('style,title,head') || !visible(element)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const lines = Array.from(range.getClientRects()).filter((rect) => rect.width > 0.5 && rect.height > 0.5).map(toRect);
    if (lines.length === 0) continue;
    const block = blockOf(element);
    if (!blocks.has(block)) blocks.set(block, blocks.size);
    const clips = [];
    for (let current = element; current && current !== document.body && current !== document.documentElement; current = current.parentElement) {
      const style = view.getComputedStyle(current);
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') clips.push(toRect(current.getBoundingClientRect()));
    }
    let coveredLines = 0;
    for (const line of lines) {
      const hit = document.elementFromPoint((line.left + line.right) / 2, (line.top + line.bottom) / 2);
      if (hit && hit !== element && !element.contains(hit) && !hit.contains(element)) coveredLines += 1;
    }
    result.push({
      id: result.length,
      text,
      blockId: blocks.get(block),
      blockText: (block.innerText || block.textContent || '').replace(/\s+/g, ' ').trim(),
      fontSize: Number.parseFloat(view.getComputedStyle(element).fontSize) || 0,
      lines,
      container: toRect(block.getBoundingClientRect()),
      clips,
      coveredLines,
    });
  }
  return result;
})()`;

function exceeds(inner: Rect, outer: Rect): boolean {
  return inner.left < outer.left - TOLERANCE_PX || inner.top < outer.top - TOLERANCE_PX
    || inner.right > outer.right + TOLERANCE_PX || inner.bottom > outer.bottom + TOLERANCE_PX;
}

function overlapArea(a: Rect, b: Rect): { width: number; height: number } {
  return { width: Math.min(a.right, b.right) - Math.max(a.left, b.left), height: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) };
}

function snippet(text: string): string {
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

/** Pure layout checks over what the browser laid out; exported for tests. */
export function findLayoutIssues(texts: LaidOutText[], width: number, height: number): ArticleImageIssue[] {
  const issues: ArticleImageIssue[] = [];
  const canvas: Rect = { left: 0, top: 0, right: width, bottom: height };
  const minimumFont = MIN_FONT_PX_AT_1080 * (width / ARTICLE_IMAGE_MIN_WIDTH);
  for (const item of texts) {
    if (item.lines.some((line) => exceeds(line, canvas))) {
      issues.push({ kind: 'clipped', text: snippet(item.text), detail: 'Text runs past the edge of the image.' });
    } else if (item.clips.some((clip) => item.lines.some((line) => exceeds(line, clip)))) {
      issues.push({ kind: 'clipped', text: snippet(item.text), detail: 'Text is cut off by a container that hides its overflow.' });
    } else if (item.lines.some((line) => exceeds(line, item.container))) {
      issues.push({ kind: 'overflow', text: snippet(item.text), detail: 'Text spills out of its box; enlarge the box, shorten the text or reduce the font size.' });
    }
    if (item.coveredLines > 0) {
      issues.push({ kind: 'covered', text: snippet(item.text), detail: 'Another element is painted on top of this text.' });
    }
    if (item.fontSize + 0.01 < minimumFont) {
      issues.push({ kind: 'small_text', text: snippet(item.text), detail: `Font size ${Math.round(item.fontSize)}px is below the ${Math.round(minimumFont)}px minimum for a ${width}px wide image.` });
    }
  }
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i]!;
      const b = texts[j]!;
      const collides = a.lines.some((lineA) => b.lines.some((lineB) => {
        const area = overlapArea(lineA, lineB);
        return area.width > TOLERANCE_PX && area.height > Math.min(lineA.bottom - lineA.top, lineB.bottom - lineB.top) * 0.25;
      }));
      if (collides) issues.push({ kind: 'overlap', text: `${snippet(a.text)} / ${snippet(b.text)}`, detail: 'These two texts are drawn on top of each other.' });
    }
  }
  const seenBlocks = new Map<string, number>();
  const reported = new Set<string>();
  const blockTexts = new Map<number, string>();
  for (const item of texts) blockTexts.set(item.blockId, item.blockText);
  for (const [blockId, text] of blockTexts) {
    const normalized = text.replace(/[\s\p{P}]/gu, '');
    if ([...normalized].length < 2) continue;
    const first = seenBlocks.get(normalized);
    if (first === undefined) {
      seenBlocks.set(normalized, blockId);
    } else if (!reported.has(normalized)) {
      reported.add(normalized);
      issues.push({ kind: 'duplicate', text: snippet(text), detail: 'The same text appears more than once in the image.' });
    }
  }
  return issues;
}
