import { Injectable, Logger } from '@nestjs/common';
import { MacosNotificationHelper, notificationPresentation, runNotificationCommand } from './macos-notification-helper';

export type HostNotification = { title: string; subtitle?: string; body: string; sound?: string };
export type HostNotificationOutcome = 'presented' | 'submitted' | 'blocked' | 'skipped' | 'failed';
// eslint-disable-next-line no-control-regex -- Strip control characters from native notification text.
const clean = (text: string, length: number) => text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length);

@Injectable()
export class HostNotificationsService {
  private readonly logger = new Logger(HostNotificationsService.name);
  private readonly helper = new MacosNotificationHelper();
  private unavailableLogged = false;

  notify(notification: HostNotification): void {
    void this.deliver(notification).catch((error) => this.logger.warn(`Host notification failed: ${error instanceof Error ? error.message : 'unknown error'}`));
  }

  async deliver(notification: HostNotification): Promise<HostNotificationOutcome> {
    if (process.platform !== 'darwin') {
      if (!this.unavailableLogged) this.logger.log(`Host notifications are macOS-only; skipped on ${process.platform}.`);
      this.unavailableLogged = true;
      return 'skipped';
    }
    try {
      const sound = (notification.sound ?? '').trim();
      const result = await this.helper.send({ title: clean(notification.title, 80), subtitle: clean(notification.subtitle ?? '', 80), body: clean(notification.body, 240),
        sound: /^[A-Za-z0-9 _.-]{1,40}$/.test(sound) ? sound : '' });
      if (result.status === 'blocked') {
        this.logger.warn(`Host notification blocked by macOS authorization/alert settings (authorization=${result.authorization}, alerts=${result.alerts}, style=${result.alertStyle}). One-time WorkLite notification setup is required.`);
        this.guide('authorization');
        return 'blocked';
      }
      if (result.status !== 'submitted' || !result.id) throw new Error('Native notification helper returned an invalid result');
      let presentation: 'presented' | 'suppressed' | 'unknown' = 'unknown';
      try {
        const logs = await runNotificationCommand('/usr/bin/log', ['show', '--style', 'json', '--last', '15s', '--info', '--debug', '--predicate', '(process == "NotificationCenter" OR process == "usernoted") AND eventMessage CONTAINS "com.worklite.notifications"'], 5_000);
        presentation = notificationPresentation(logs, result.id);
      } catch { /* Unified-log access is optional; acceptance is not presentation. */ }
      if (presentation === 'suppressed') {
        this.logger.warn(`Host notification ${result.id} was suppressed by macOS Focus/presentation policy. Allow WorkLite 通知 in the active Focus and check its notification settings.`);
        this.guide('focus');
        return 'blocked';
      }
      this.logger.log(`Host notification ${result.id}: ${presentation === 'presented' ? 'banner presentation confirmed by NotificationCenter' : 'submitted; banner visibility unconfirmed'} (inCenter=${result.inNotificationCenter}, timeSensitive=${result.timeSensitive}).`);
      return presentation === 'presented' ? 'presented' : 'submitted';
    } catch (error) {
      this.logger.warn(`Host notification failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return 'failed';
    }
  }

  private guide(reason: 'authorization' | 'focus') {
    void this.helper.guide(reason).catch((error) => this.logger.warn(`Host notification setup guide failed: ${error instanceof Error ? error.message : 'unknown error'}`));
  }
}
