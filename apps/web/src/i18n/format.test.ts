import { describe, expect, it } from 'vitest';
import { formatTokenCount } from './format';

describe('formatTokenCount', () => {
  it.each([
    [0, '0k'], [1, '0.001k'], [20, '0.02k'], [120, '0.12k'], [999, '0.999k'],
    [1000, '1k'], [1234, '1.234k'], [12000, '12k'], [12345, '12.345k'],
    [999950, '999.95k'], [1000000, '1,000k'], [1234567, '1,234.567k'],
  ])('formats %s tokens as %s', (value, expected) => {
    expect(formatTokenCount(value, 'zh-CN')).toBe(expected);
  });
});
