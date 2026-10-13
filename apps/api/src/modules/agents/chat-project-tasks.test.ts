import { describe, expect, it } from 'vitest';
import { extractTaskResult, settleChatProjectTask } from './chat-project-tasks.service';

describe('extractTaskResult', () => {
  it('parses a bare succeeded result', () => {
    expect(extractTaskResult('{"status":"succeeded","summary":"done"}')).toEqual({ status: 'succeeded', summary: 'done' });
  });

  it('parses a waiting_for_input result', () => {
    expect(extractTaskResult('{"status":"waiting_for_input","pendingInput":{"question":"which file?"}}'))
      .toEqual({ status: 'waiting_for_input', question: 'which file?' });
  });

  it('parses a fully fenced result', () => {
    expect(extractTaskResult('```json\n{"status":"succeeded","summary":"done"}\n```')).toEqual({ status: 'succeeded', summary: 'done' });
  });

  it('extracts a fenced result surrounded by prose', () => {
    const output = '工作已完成，结果如下：\n```json\n{"status":"succeeded","summary":"已修复解析"}\n```\n以上。';
    expect(extractTaskResult(output)).toEqual({ status: 'succeeded', summary: '已修复解析' });
  });

  it('extracts a result when prose follows the fence', () => {
    const output = '```json\n{"status":"succeeded","summary":"已提交"}\n```\n\n## 下一步\n等你确认。';
    expect(extractTaskResult(output)).toEqual({ status: 'succeeded', summary: '已提交' });
  });

  it('extracts an unfenced result embedded in prose', () => {
    expect(extractTaskResult('完成了。{"status":"succeeded","summary":"ok"} 如有问题请继续。'))
      .toEqual({ status: 'succeeded', summary: 'ok' });
  });

  it('skips JSON values without the result shape and keeps scanning', () => {
    const output = '配置示例 {"status":"draft","note":"ignore me"}，最终结果：{"status":"succeeded","summary":"real"}';
    expect(extractTaskResult(output)).toEqual({ status: 'succeeded', summary: 'real' });
  });

  it('tolerates raw control characters inside string values', () => {
    const output = '{"status":"succeeded","summary":"第一行\n第二行"}';
    expect(extractTaskResult(output)).toEqual({ status: 'succeeded', summary: '第一行\n第二行' });
  });

  it('returns null for truncated JSON', () => {
    expect(extractTaskResult('{"status":"succeeded","summary":"写了一半')).toBeNull();
  });

  it('returns null for prose without any result JSON', () => {
    expect(extractTaskResult('调研进展汇报：仍在阅读架构文档。')).toBeNull();
  });

  it('returns null for JSON with an unsupported status', () => {
    expect(extractTaskResult('{"status":"failed","error":"boom"}')).toBeNull();
  });
});

describe('settleChatProjectTask', () => {
  it('settles a clean result without diagnostics', () => {
    expect(settleChatProjectTask('{"status":"succeeded","summary":"done"}', []))
      .toEqual({ status: 'succeeded', result: 'done', error: null });
  });

  it('settles waiting_for_input from the output', () => {
    expect(settleChatProjectTask('{"status":"waiting_for_input","pendingInput":{"question":"授权吗？"}}', []))
      .toEqual({ status: 'waiting_for_input', question: '授权吗？' });
  });

  it('recovers the result from the latest activity message when the final output is prose', () => {
    const activities = ['早期汇报', '{"status":"succeeded","summary":"五项需求全部完成"}'];
    const settlement = settleChatProjectTask('调研进展汇报：仍在进行中。', activities.reverse());
    expect(settlement.status).toBe('succeeded');
    expect(settlement).toMatchObject({ result: '五项需求全部完成' });
    expect(settlement.status === 'succeeded' && settlement.error).toMatch('解析降级');
  });

  it('recovers waiting_for_input from an activity message', () => {
    const settlement = settleChatProjectTask('我还需要确认一件事', ['{"status":"waiting_for_input","pendingInput":{"question":"选 A 还是 B？"}}']);
    expect(settlement).toEqual({ status: 'waiting_for_input', question: '选 A 还是 B？' });
  });

  it('degrades to a succeeded task holding the raw output when nothing parses', () => {
    const settlement = settleChatProjectTask('执行器只返回了散文。', []);
    expect(settlement.status).toBe('succeeded');
    expect(settlement).toMatchObject({ result: '执行器只返回了散文。' });
    expect(settlement.status === 'succeeded' && settlement.error).toMatch('解析降级');
  });

  it('degrades truncated JSON output instead of failing', () => {
    const settlement = settleChatProjectTask('{"status":"succeeded","summary":"截断', []);
    expect(settlement.status).toBe('succeeded');
    expect(settlement.status === 'succeeded' && settlement.error).toMatch('解析降级');
  });
});
