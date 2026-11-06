import { describe, expect, it } from 'vitest';
import { formatWechatReply, splitWechatText, WECHAT_TEXT_BYTES } from './wechat-reply-format';

const texts = (markdown: string) => formatWechatReply(markdown).flatMap((part) => part.kind === 'text' ? [part.text] : []);

describe('WeChat reply formatting', () => {
  it('keeps the supported subset and removes unsupported emphasis and deep headings', () => {
    expect(texts('# 标题\n\n**粗体** and *English*，*中文*，***中文加粗斜体***，~~删除~~\n\n##### 小标题\n\n`a_b < 2`')[0])
      .toBe('# 标题\n\n**粗体** and *English*，中文，**中文加粗斜体**，删除\n\n小标题\n\n`a_b < 2`');
  });

  it('keeps line breaks, nested lists, task state and visible link destinations', () => {
    const output = texts('1. [官网](https://example.com)\n2. 第二项\n   - [x] 已完成\n\n前行  \n后行')[0];
    expect(output).toContain('1. 官网（https://example.com）');
    expect(output).toContain('2. 第二项');
    expect(output).toContain('2. 第二项\n   - [x] 已完成');
    expect(output).toContain('前行\n后行');
  });

  it('renders table cells as readable header/value rows without losing images', () => {
    const parts = formatWechatReply('| 名称 | 值 |\n| --- | --- |\n| A | **10** |\n| B | ![截图](/api/artifacts/art_one/content) |');
    expect(parts).toEqual([
      { kind: 'text', text: '名称：A\n值：**10**\n\n名称：B\n值：' },
      { kind: 'artifact', id: 'art_one' },
    ]);
    expect(texts('| `<key>` |\n| --- |\n| value |')).toEqual(['`<key>`：value']);
  });

  it('preserves every native image in order and exposes external images as links', () => {
    expect(formatWechatReply('之前\n![图](/api/artifacts/art_one/content)\n[附件](/api/chat/attachments/att_two)\n/api/artifacts/art_one/content\n![外部图](https://example.com/a.png)')).toEqual([
      { kind: 'text', text: '之前' }, { kind: 'artifact', id: 'art_one' },
      { kind: 'attachment', id: 'att_two' }, { kind: 'artifact', id: 'art_one' },
      { kind: 'text', text: '外部图（https://example.com/a.png）' },
    ]);
  });

  it('does not send image references inside literal code and preserves its blank lines', () => {
    const code = '![示例](/api/artifacts/art_sample/content)\n\n\nif (a < 2) { return "**literal**"; }';
    expect(formatWechatReply('```js\n' + code + '\n```\n\n`/api/chat/attachments/att_example`')).toEqual([
      { kind: 'text', text: '```js\n' + code + '\n```\n\n`/api/chat/attachments/att_example`' },
    ]);
    expect(texts('CPU <80% <b>正常</b>')[0]).toBe('CPU ＜80% ＜b＞正常＜/b＞');
  });

  it('splits long Unicode text losslessly without breaking graphemes', () => {
    const grapheme = '👨‍👩‍👧‍👦';
    const input = ('微信 e\u0301 ' + grapheme + '\n').repeat(500);
    const chunks = splitWechatText(input);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(input);
    expect(chunks.every((part) => Buffer.byteLength(part) <= WECHAT_TEXT_BYTES)).toBe(true);
    expect(chunks.every((part) => !part.startsWith('\u200d') && !part.endsWith('\u200d'))).toBe(true);
    const prose = '长回复😀'.repeat(1500);
    expect(texts(prose).join('')).toBe(prose);
    expect(splitWechatText('第一段\n\n第二段\n\n第三段', 24)).toEqual(['第一段\n\n第二段\n\n', '第三段']);
    expect(splitWechatText('第一行\n第二行\n第三行', 22)).toEqual(['第一行\n第二行\n', '第三行']);
  });

  it('closes/reopens long fences, preserving all code and staying within the byte budget', () => {
    const code = 'const x = "中文😀";\n\n\n'.repeat(450);
    const chunks = texts('```ts\n' + code + '\n```');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((part) => part.startsWith('```ts\n') && part.endsWith('\n```') && Buffer.byteLength(part) <= WECHAT_TEXT_BYTES)).toBe(true);
    expect(chunks.map((part) => part.slice(6, -4)).join('')).toBe(code);
  });

  it('keeps short Markdown blocks intact and falls back for oversized formatted prose', () => {
    const paragraph = '**段落**\n\n';
    const chunks = texts(paragraph.repeat(500));
    expect(chunks.every((part) => Buffer.byteLength(part) <= WECHAT_TEXT_BYTES && !part.includes('�'))).toBe(true);
    expect(chunks.join('\n\n').match(/\*\*段落\*\*/g)).toHaveLength(500);
    expect(texts('**' + '长'.repeat(2000) + '**').join('')).toBe('长'.repeat(2000));
    expect(formatWechatReply('   \n\n')).toEqual([]);
  });

  it('protects literal code when an oversized paragraph or list must fall back', () => {
    for (const markdown of ['说明'.repeat(2000) + ' `a < 2 && b > 1`', '- ' + '说明'.repeat(2000) + ' `a < 2 && b > 1`']) {
      const chunks = texts(markdown);
      expect(chunks.every((part) => part.startsWith('```\n') && part.endsWith('\n```') && Buffer.byteLength(part) <= WECHAT_TEXT_BYTES)).toBe(true);
      expect(chunks.map((part) => part.slice(4, -4)).join('')).toContain('`a < 2 && b > 1`');
    }
  });
});
