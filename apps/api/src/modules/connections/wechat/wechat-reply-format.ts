import { Lexer, type Token, type Tokens } from 'marked';
import { splitWechatReplyImages, type WechatReplyPart } from '../../artifacts/wechat-reply-images';

// WorkLite's conservative UTF-8 budget, NOT an iLink server contract. The upstream
// adapter advertises 4000 characters but its protocol does not define a hard limit.
export const WECHAT_TEXT_BYTES = 3_500;
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const safeText = (text: string) => text.replace(/</g, '＜').replace(/>/g, '＞');

function append(parts: WechatReplyPart[], next: WechatReplyPart): void {
  const last = parts.at(-1);
  if (next.kind === 'text' && last?.kind === 'text') last.text += next.text;
  else parts.push({ ...next });
}

function decorate(parts: WechatReplyPart[], before: string, after = ''): WechatReplyPart[] {
  // Inline media is sent as separate native messages, so never leave open markup
  // on either side of an image.
  if (parts.some((part) => part.kind !== 'text')) return parts;
  return [{ kind: 'text', text: before + parts.map((part) => part.kind === 'text' ? part.text : '').join('') + after }];
}

function codeFence(text: string, language = ''): { open: string; close: string } {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return { open: fence + language.replace(/[^a-zA-Z0-9_+-]/g, '').slice(0, 40) + '\n', close: '\n' + fence };
}

/** Render the subset evidenced by Tencent's markdown-filter.ts; keep a plain
 * fallback for oversized prose blocks. We never fetch arbitrary image URLs. */
function render(tokens: Token[] = [], plain = false): WechatReplyPart[] {
  const parts: WechatReplyPart[] = [];
  const text = (value: string) => append(parts, { kind: 'text', text: value });
  const add = (values: WechatReplyPart[]) => values.forEach((part) => append(parts, part));
  for (const token of tokens) {
    switch (token.type) {
      case 'space': break;
      case 'checkbox': break; // Task state is rendered once by its owning list item.
      case 'def': break;
      case 'br': text('\n'); break;
      case 'hr': text(plain ? '\n\n' : '\n---\n'); break;
      case 'code': {
        const code = token as Tokens.Code;
        const fence = codeFence(code.text, code.lang);
        text(plain ? code.text : fence.open + code.text + fence.close);
        text('\n\n');
        break;
      }
      case 'codespan': text(token.raw); break;
      case 'escape': text(token.raw); break;
      case 'strong': add(decorate(render(token.tokens, plain), plain ? '' : '**', plain ? '' : '**')); break;
      case 'em': {
        const content = render(token.tokens, plain);
        const marker = plain || cjk.test(token.text) ? '' : '*';
        add(decorate(content, marker, marker));
        break;
      }
      case 'del': add(render(token.tokens, plain)); break;
      case 'heading':
        add(decorate(render(token.tokens, plain), !plain && token.depth <= 4 ? '#'.repeat(token.depth) + ' ' : ''));
        text('\n\n');
        break;
      case 'paragraph': add(render(token.tokens, plain)); text('\n\n'); break;
      case 'blockquote':
        // Plain quotation lines remain readable even on clients without styling.
        add(render(token.tokens, plain).map((part) => part.kind === 'text' ? { ...part, text: part.text.trim().replace(/^/gm, '> ') + '\n\n' } : part));
        break;
      case 'list': {
        const list = token as Tokens.List;
        list.items.forEach((item, index) => {
          const prefix = list.ordered ? `${Number(list.start) + index}. ` : '- ';
          const task = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';
          const children = render(item.tokens, plain);
          if (children[0]?.kind === 'text') {
            const body = children[0].text.trimStart().replace(/\n(?!$)/g, '\n' + ' '.repeat(prefix.length));
            children[0].text = prefix + task + body;
          }
          add(children);
          text('\n');
        });
        text('\n');
        break;
      }
      case 'table': {
        const table = token as Tokens.Table;
        // A wide table is hard to read on a phone. Repeat its existing headers
        // beside each value; no fields or commentary are added.
        table.rows.forEach((row) => {
          row.forEach((cell, index) => {
            add(render(table.header[index]?.tokens ?? [], true));
            text('：');
            add(render(cell.tokens, plain));
            text('\n');
          });
          text('\n');
        });
        if (!table.rows.length) table.header.forEach((cell) => { add(render(cell.tokens, plain)); text('\n'); });
        break;
      }
      case 'link': case 'image': {
        const link = token as Tokens.Link | Tokens.Image;
        const native = splitWechatReplyImages(link.href);
        if (native.length === 1 && native[0].kind !== 'text') add(native);
        else {
          const label = link.type === 'image' ? safeText(link.text) : render(link.tokens, true).map((part) => part.kind === 'text' ? part.text : '').join('');
          // Keep the destination visible; clickability/preview is client-specific.
          text(label && label !== link.href ? `${label}（${safeText(link.href)}）` : safeText(link.href));
        }
        break;
      }
      case 'html': text(safeText(token.text)); break;
      default:
        if ('tokens' in token && token.tokens) {
          add(render(token.tokens, plain));
          if (token.type === 'text' && token.raw.endsWith('\n')) text('\n');
        } else {
          const value = safeText('text' in token ? token.text : token.raw);
          const references = splitWechatReplyImages(value);
          if (references.some((part) => part.kind !== 'text')) add(references);
          else text(value);
        }
    }
  }
  return parts;
}

/** Lossless UTF-8 splitting: paragraph/line/space boundaries first, then Unicode
 * graphemes. Only a single pathological grapheme larger than the budget is split. */
export function splitWechatText(text: string, budget = WECHAT_TEXT_BYTES): string[] {
  if (!Number.isInteger(budget) || budget < 4) throw new Error('WeChat text budget must be at least 4 bytes.');
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  const push = () => { if (chunk) chunks.push(chunk); chunk = ''; bytes = 0; };
  const appendUnit = (unit: string) => {
    const size = Buffer.byteLength(unit);
    if (bytes + size > budget) push();
    chunk += unit; bytes += size;
  };
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const paragraph of text.split(/(?<=\n\n)/u)) {
    if (Buffer.byteLength(paragraph) <= budget) { appendUnit(paragraph); continue; }
    for (const line of paragraph.split(/(?<=\n)/u)) {
      if (Buffer.byteLength(line) <= budget) { appendUnit(line); continue; }
      for (const word of line.match(/\S+\s*|\s+/gu) ?? []) {
        if (Buffer.byteLength(word) <= budget) { appendUnit(word); continue; }
        for (const { segment } of segmenter.segment(word)) {
          if (Buffer.byteLength(segment) <= budget) appendUnit(segment);
          else for (const point of segment) appendUnit(point);
        }
      }
    }
  }
  push();
  return chunks;
}

function literalChunks(text: string, language = ''): string[] {
  const fence = codeFence(text, language);
  const budget = WECHAT_TEXT_BYTES - Buffer.byteLength(fence.open + fence.close);
  // A pathological source fence can itself exceed a message. Its text still
  // survives without adding an even larger wrapper.
  if (budget < 4) return splitWechatText(text);
  return splitWechatText(text, budget).map((part) => fence.open + part + fence.close);
}

function containsCode(token: Token): boolean {
  if (token.type === 'code' || token.type === 'codespan') return true;
  if (token.type === 'list') return (token as Tokens.List).items.some((item) => item.tokens.some(containsCode));
  return 'tokens' in token && Boolean(token.tokens?.some(containsCode));
}

function chunkFormattedText(text: string): string[] {
  if (Buffer.byteLength(text) <= WECHAT_TEXT_BYTES) return text.trim() ? [text.trim()] : [];
  const chunks: string[] = [];
  let pending = '';
  const flush = () => { if (pending.trim()) chunks.push(pending.trim()); pending = ''; };
  // Re-lex the complete formatted text before splitting so code is never run
  // through prose conversions and every sent fence can close independently.
  for (const token of Lexer.lex(text)) {
    if (Buffer.byteLength(token.raw) <= WECHAT_TEXT_BYTES) {
      if (Buffer.byteLength(pending + token.raw) > WECHAT_TEXT_BYTES) flush();
      pending += token.raw;
      continue;
    }
    flush();
    if (token.type === 'code') {
      const code = token as Tokens.Code;
      chunks.push(...literalChunks(code.text, code.lang));
    } else if (containsCode(token)) {
      // Oversized mixed prose/code cannot safely lose its inline delimiters:
      // protect the block's source as literal text rather than corrupt commands
      // or let the client's HTML parser swallow code containing angle brackets.
      chunks.push(...literalChunks(token.raw.trimEnd()));
    } else {
      const plain = render([token], true).map((part) => part.kind === 'text' ? part.text : '').join('').trim();
      chunks.push(...splitWechatText(plain).filter((part) => part.trim()));
    }
  }
  flush();
  return chunks;
}

export function formatWechatReply(markdown: string): WechatReplyPart[] {
  return render(Lexer.lex(markdown)).flatMap((part): WechatReplyPart[] => part.kind === 'text'
    ? chunkFormattedText(part.text).map((text) => ({ kind: 'text', text }))
    : [part]);
}
