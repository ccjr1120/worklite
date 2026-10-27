import { describe, expect, it } from 'vitest';
import { appleScriptStringLiteral, hostNotificationScript } from './host-notifications.service';

describe('appleScriptStringLiteral', () => {
  it('escapes quotes and backslashes so caller text cannot close the literal', () => {
    expect(appleScriptStringLiteral('say "hi" \\ now', 100)).toBe('"say \\"hi\\" \\\\ now"');
  });

  it('flattens newlines and control characters into single spaces', () => {
    expect(appleScriptStringLiteral('first\nsecond\tthird\r\n', 100)).toBe('"first second third"');
  });

  it('truncates past the limit with a marker', () => {
    expect(appleScriptStringLiteral('abcdefghij', 5)).toBe('"abcd…"');
  });
});

describe('hostNotificationScript', () => {
  it('builds one display notification command with title, subtitle and sound', () => {
    expect(hostNotificationScript({ title: 'WorkLite', subtitle: '对话完成', body: '已完成', sound: 'Glass' }))
      .toBe('display notification "已完成" with title "WorkLite" subtitle "对话完成" sound name "Glass"');
  });

  it('omits an empty subtitle and an empty sound name', () => {
    expect(hostNotificationScript({ title: 'WorkLite', subtitle: '  ', body: '已完成', sound: '' }))
      .toBe('display notification "已完成" with title "WorkLite"');
  });

  it('drops a sound name macOS would not accept instead of passing it through', () => {
    expect(hostNotificationScript({ title: 'WorkLite', body: 'x', sound: 'Glass" & (do shell script "id")' }))
      .toBe('display notification "x" with title "WorkLite"');
  });

  it('keeps an injection attempt inside the body literal', () => {
    const script = hostNotificationScript({ title: 'WorkLite', body: '" & (do shell script "id") & "' });
    expect(script).toBe('display notification "\\" & (do shell script \\"id\\") & \\"" with title "WorkLite"');
  });
});
