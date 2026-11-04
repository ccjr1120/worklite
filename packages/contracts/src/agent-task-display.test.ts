import { describe, expect, it } from 'vitest';
import { agentTaskDisplayText } from './index';
describe('selected Agent message display', () => {
  it('shows the selected Agent name and task without the internal routing id', () => {
    expect(agentTaskDisplayText('请调用 Agent Project Agent（id: agt_internal-id）完成任务：\n完成代码修改')).toBe('@Project Agent\n完成代码修改');
  });
  it('keeps ordinary user text and explicitly written ids unchanged', () => {
    expect(agentTaskDisplayText('查看 agt_internal-id 的配置')).toBe('查看 agt_internal-id 的配置');
  });
});
