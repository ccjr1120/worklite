import { describe, expect, it } from 'vitest';
import { formatTokenCount } from './format';

describe('formatTokenCount', () => {
  it.each([
    [0, '0.0k'], [1, '0.0k'], [20, '0.0k'], [120, '0.1k'], [999, '1.0k'],
    [1000, '1.0k'], [1234, '1.2k'], [12000, '12.0k'], [12345, '12.3k'],
    [411796, '411.8k'], [999950, '1,000.0k'], [1000000, '1,000.0k'], [1234567, '1,234.6k'],
  ])('formats %s tokens as %s', (value, expected) => {
    expect(formatTokenCount(value, 'zh-CN')).toBe(expected);
  });
});
