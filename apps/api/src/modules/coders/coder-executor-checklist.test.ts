import { describe, expect, it } from 'vitest';
import { parseExecutorChecklist } from './coder-runtime.service';

describe('executor checklist', () => {
  it('reads explicit step states without treating ordinary prose as completed work', () => {
    expect(parseExecutorChecklist('实施计划\n- [x] 修改登录页\n- [~] 补充测试\n- [ ] 验证结果\n正在处理')).toEqual([
      { step: '修改登录页', status: 'completed' },
      { step: '补充测试', status: 'in_progress' },
      { step: '验证结果', status: 'pending' },
    ]);
  });
});
