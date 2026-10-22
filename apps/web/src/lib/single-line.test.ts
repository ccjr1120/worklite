import { describe, expect, it } from 'vitest';
import { toSingleLine } from './single-line';

describe('toSingleLine', () => {
  it('returns an empty string for missing text', () => {
    expect(toSingleLine(null)).toBe('');
    expect(toSingleLine('  \n ')).toBe('');
  });

  it('uses the first meaningful line and strips Markdown markers', () => {
    expect(toSingleLine('## **检查** `登录` 状态\n后续细节')).toBe('检查 登录 状态');
    expect(toSingleLine('- [ ] 修复 [文档](https://example.com)')).toBe('修复 文档');
    expect(toSingleLine('\n\n> 引用内容')).toBe('引用内容');
    expect(toSingleLine('1. 第一步\n2. 第二步')).toBe('第一步');
  });

  it('skips code fence markers and table separators', () => {
    expect(toSingleLine('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(toSingleLine('| a | b |\n| --- | --- |')).toBe('a · b');
  });
});
