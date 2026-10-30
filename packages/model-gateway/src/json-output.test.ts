import { describe, expect, it } from 'vitest';
import { AgentJsonOutputError, extractJsonText } from './index';

describe('extractJsonText', () => {
  it('finds the top-level JSON object inside surrounding prose', () => {
    expect(extractJsonText('Here is the plan:\n{"status":"completed","notes":"a } b"}\nDone.')).toBe('{"status":"completed","notes":"a } b"}');
  });

  it('keeps the reply text when it contains no JSON so a caller can ask for a correction', () => {
    const report = '## 1. 代码位置\n文字写在 wechat.service.ts 的 deliver() 里。';
    let failure: unknown;
    try {
      extractJsonText(report);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AgentJsonOutputError);
    expect((failure as AgentJsonOutputError).message).toBe('Agent JSON output requires valid JSON.');
    expect((failure as AgentJsonOutputError).output).toBe(report);
  });
});
