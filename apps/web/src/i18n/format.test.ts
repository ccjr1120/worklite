import { describe, expect, it } from 'vitest';
import { formatTokenCount } from './format';

describe('formatTokenCount', () => {
  it('keeps counts below 1,000 as plain numbers', () => {
    expect(formatTokenCount(0, 'zh-CN')).toBe('0');
    expect(formatTokenCount(999, 'zh-CN')).toBe('999');
  });

  it('shows thousands as k with at most one decimal', () => {
    expect(formatTokenCount(1000, 'zh-CN')).toBe('1k');
    expect(formatTokenCount(1234, 'zh-CN')).toBe('1.2k');
    expect(formatTokenCount(12000, 'zh-CN')).toBe('12k');
    expect(formatTokenCount(12345, 'zh-CN')).toBe('12.3k');
    expect(formatTokenCount(999949, 'zh-CN')).toBe('999.9k');
  });

  it('carries values that would round to 1000k over to M', () => {
    expect(formatTokenCount(999950, 'zh-CN')).toBe('1M');
    expect(formatTokenCount(1234567, 'zh-CN')).toBe('1.2M');
  });
});
