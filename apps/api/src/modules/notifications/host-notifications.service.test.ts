// @vitest-environment node
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as native from './macos-notification-helper';
import { HostNotificationsService } from './host-notifications.service';

const platform = process.platform;
beforeEach(() => Object.defineProperty(process, 'platform', { value: 'darwin' }));
afterEach(() => { Object.defineProperty(process, 'platform', { value: platform }); vi.restoreAllMocks(); });
const payload = { title: 'WorkLite', subtitle: '对话完成', body: '真实测试通知', sound: 'Glass' };

describe('macOS host notifications', () => {
  it('skips unsupported hosts without launching a helper', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const send = vi.spyOn(native.MacosNotificationHelper.prototype, 'send');
    expect(await new HostNotificationsService().deliver(payload)).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
  });
  it('does not label a successfully submitted notification as a visible banner', async () => {
    const send = vi.spyOn(native.MacosNotificationHelper.prototype, 'send').mockResolvedValue({ status: 'submitted', id: 'request', inNotificationCenter: true });
    vi.spyOn(native, 'runNotificationCommand').mockResolvedValue('[]');
    expect(await new HostNotificationsService().deliver(payload)).toBe('submitted');
    expect(send).toHaveBeenCalledWith(payload);
  });
  it('records an actual system banner presentation when observable', async () => {
    vi.spyOn(native.MacosNotificationHelper.prototype, 'send').mockResolvedValue({ status: 'submitted', id: 'request' });
    vi.spyOn(native, 'runNotificationCommand').mockResolvedValue(JSON.stringify([{ eventMessage: 'com.worklite.notifications:request canDisplayWhileCenterIsClosed: true' }]));
    expect(await new HostNotificationsService().deliver(payload)).toBe('presented');
  });
  it('warns and offers a one-time guide when Focus suppresses the notification', async () => {
    vi.spyOn(native.MacosNotificationHelper.prototype, 'send').mockResolvedValue({ status: 'submitted', id: 'request' });
    vi.spyOn(native, 'runNotificationCommand').mockResolvedValue(JSON.stringify([{ eventMessage: 'request muted by DND suppression: silence' }]));
    const guide = vi.spyOn(native.MacosNotificationHelper.prototype, 'guide').mockResolvedValue();
    const warning = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    expect(await new HostNotificationsService().deliver(payload)).toBe('blocked');
    expect(guide).toHaveBeenCalledWith('focus');
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('suppressed by macOS Focus'));
  });
  it('detects disabled permission and preserves a native one-time authorization guide', async () => {
    vi.spyOn(native.MacosNotificationHelper.prototype, 'send').mockResolvedValue({ status: 'blocked', authorization: 1, alerts: false });
    const guide = vi.spyOn(native.MacosNotificationHelper.prototype, 'guide').mockResolvedValue();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    expect(await new HostNotificationsService().deliver(payload)).toBe('blocked');
    expect(guide).toHaveBeenCalledWith('authorization');
  });
  it('makes failures visible at warning level and never rejects a completed Chat turn', async () => {
    vi.spyOn(native.MacosNotificationHelper.prototype, 'send').mockRejectedValue(new Error('compiler unavailable'));
    const warning = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    expect(await new HostNotificationsService().deliver(payload)).toBe('failed');
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('compiler unavailable'));
  });
  it('bounds text and sends data over stdin rather than interpreting AppleScript', async () => {
    const send = vi.spyOn(native.MacosNotificationHelper.prototype, 'send').mockResolvedValue({ status: 'submitted', id: 'request' });
    vi.spyOn(native, 'runNotificationCommand').mockRejectedValue(new Error('log access unavailable'));
    expect(await new HostNotificationsService().deliver({ ...payload, title: 'x'.repeat(100), body: 'a\nb', sound: 'Glass"; command' })).toBe('submitted');
    expect(send).toHaveBeenCalledWith({ ...payload, title: 'x'.repeat(80), body: 'a b', sound: '' });
  });
  it('does not confuse another request with this notification', () => {
    expect(native.notificationPresentation(JSON.stringify([{ eventMessage: 'old muted by DND suppression: silence' }]), 'new')).toBe('unknown');
  });
  it('correlates real macOS short ids to detect Focus suppression after successful submission', () => {
    const logs = JSON.stringify([
      { eventMessage: 'Added request <NotificationRecord app:"com.worklite.notifications" ident:"26A5-5689" req:"request-uuid" uuid:"ED9FCFA2">' },
      { eventMessage: '26A5-5689 (com.worklite.notifications) muted by DND suppression: silence' },
      { eventMessage: 'addOrUpdate listItem: com.worklite.notifications:ED9FCFA2:26A5-5689, canDisplayWhileCenterIsClosed: false' },
    ]);
    expect(native.notificationPresentation(logs, 'request-uuid')).toBe('suppressed');
    expect(native.notificationPresentation(logs.replace('false', 'true'), 'request-uuid')).toBe('suppressed');
  });
  it('confirms an eligible banner through the linked NotificationCenter record', () => {
    expect(native.notificationPresentation(JSON.stringify([
      { eventMessage: '<NotificationRecord ident:"short-id" req:"request-uuid" uuid:"record-id">' },
      { eventMessage: 'com.worklite.notifications:record-id:short-id, canDisplayWhileCenterIsClosed: true' },
    ]), 'request-uuid')).toBe('presented');
  });
});

it.skipIf(process.env.WORKLITE_LIVE_NOTIFICATION_SMOKE !== '1')('sends a real WorkLite notification on the macOS host', async () => {
  const result = await new HostNotificationsService().deliver({ ...payload, body: 'WorkLite 通知链路已修复。这是一条真实测试通知。' });
  console.info(`WORKLITE_NOTIFICATION_SMOKE=${result}`);
  expect(result).toBe('presented');
}, 180_000);
