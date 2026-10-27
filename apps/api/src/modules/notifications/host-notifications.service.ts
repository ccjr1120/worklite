import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

const OSASCRIPT_PATH = '/usr/bin/osascript';
const NOTIFICATION_TIMEOUT_MS = 5_000;
const MAX_TITLE_CHARS = 80;
const MAX_SUBTITLE_CHARS = 80;
const MAX_BODY_CHARS = 240;
const MAX_SOUND_CHARS = 40;
const SOUND_NAME_PATTERN = /^[A-Za-z0-9 _.-]+$/;

export type HostNotification = {
  title: string;
  subtitle?: string;
  body: string;
  // A macOS system sound name such as Glass; an empty or omitted name delivers the notification silently.
  sound?: string;
};

export type HostNotificationOutcome = 'delivered' | 'skipped' | 'failed';

// Every field reaches AppleScript as a quoted string literal, so backslashes and quotes are escaped and
// newlines and other control characters are flattened: no caller text can close the literal, add a
// statement or break the single-line command.
export function appleScriptStringLiteral(value: string, maxChars: number): string {
  const flattened = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const bounded = flattened.length > maxChars ? `${flattened.slice(0, maxChars - 1)}…` : flattened;
  return `"${bounded.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// An unexpected sound name is dropped rather than escaped into the command: macOS only accepts names
// from its installed sound set, and a rejected name would suppress the whole notification.
function soundClause(sound: string | undefined): string {
  const name = (sound ?? '').trim();
  if (!name || name.length > MAX_SOUND_CHARS || !SOUND_NAME_PATTERN.test(name)) return '';
  return ` sound name ${appleScriptStringLiteral(name, MAX_SOUND_CHARS)}`;
}

export function hostNotificationScript(notification: HostNotification): string {
  const subtitle = notification.subtitle?.trim()
    ? ` subtitle ${appleScriptStringLiteral(notification.subtitle, MAX_SUBTITLE_CHARS)}`
    : '';
  return `display notification ${appleScriptStringLiteral(notification.body, MAX_BODY_CHARS)}`
    + ` with title ${appleScriptStringLiteral(notification.title, MAX_TITLE_CHARS)}`
    + subtitle
    + soundClause(notification.sound);
}

// Posts a macOS system notification on the WorkLite host through osascript. It is a side channel for
// work the user has to come back to: delivery is best effort, bounded by a timeout, and never reported
// as an error to the caller. Reusable by any producer of a settled unit of work (Chat turns today;
// project tasks, Team Runs and Workflow Runs can call the same service).
@Injectable()
export class HostNotificationsService {
  private readonly logger = new Logger(HostNotificationsService.name);
  private unavailableLogged = false;

  // Fire-and-forget entry point: it returns immediately and swallows every failure into a log line.
  notify(notification: HostNotification): void {
    void this.deliver(notification).catch((error) => {
      this.logger.debug(`Host notification failed: ${error instanceof Error ? error.message : 'unknown error'}.`);
    });
  }

  async deliver(notification: HostNotification): Promise<HostNotificationOutcome> {
    if (process.platform !== 'darwin') {
      this.logUnavailableOnce(`Host notifications are macOS-only; skipped on ${process.platform}.`);
      return 'skipped';
    }
    try {
      accessSync(OSASCRIPT_PATH, constants.X_OK);
    } catch {
      this.logUnavailableOnce(`Host notifications need an executable ${OSASCRIPT_PATH}; skipped.`);
      return 'skipped';
    }
    const script = hostNotificationScript(notification);
    return await new Promise<HostNotificationOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: HostNotificationOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const child = spawn(OSASCRIPT_PATH, ['-e', script], { stdio: 'ignore', detached: false });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        this.logger.debug('Host notification timed out.');
        finish('failed');
      }, NOTIFICATION_TIMEOUT_MS);
      child.on('error', (error) => {
        this.logger.debug(`Host notification could not start: ${error.message}.`);
        finish('failed');
      });
      child.on('close', (code) => {
        if (code !== 0) this.logger.debug(`Host notification exited with code ${code}.`);
        finish(code === 0 ? 'delivered' : 'failed');
      });
    });
  }

  // One line per process: an unsupported host would otherwise log on every settled turn.
  private logUnavailableOnce(message: string): void {
    if (this.unavailableLogged) return;
    this.unavailableLogged = true;
    this.logger.debug(message);
  }
}
