import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const BUNDLE_ID = 'com.worklite.notifications';
const APP_NAME = 'WorkLite Notifications.app';
const EXECUTABLE = 'worklite-notifications';

export function runNotificationCommand(command: string, args: string[], timeout: number, input?: string): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command} timed out after ${timeout}ms`)); }, timeout);
    child.stdout.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-262_144); });
    child.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4_096); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) accept(output);
      else reject(new Error(`${command} exited ${signal ?? code}: ${errors.trim() || output.trim()}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export type NativeNotificationResult = {
  status: 'settings' | 'submitted' | 'blocked' | 'failed';
  id?: string; reason?: string; authorization?: number; alerts?: boolean; alertStyle?: number;
  timeSensitive?: boolean; inNotificationCenter?: boolean;
};

export class MacosNotificationHelper {
  private prepared?: Promise<{ executable: string; directory: string }>;
  constructor(private readonly command: typeof runNotificationCommand = runNotificationCommand) {}

  async prepare(): Promise<{ executable: string; directory: string }> {
    if (!this.prepared) this.prepared = this.install().catch((error) => { this.prepared = undefined; throw error; });
    return this.prepared;
  }

  private async install() {
    const roots = [process.env.WORKLITE_RELEASE_ROOT, process.env.WORKLITE_PROJECT_ROOT, process.cwd(), resolve(process.cwd(), '../..')].filter((root): root is string => Boolean(root));
    let source: Buffer | undefined;
    let root = '';
    for (const candidate of roots) {
      try { source = await readFile(join(candidate, 'scripts/macos-notifications.swift')); root = candidate; break; } catch { /* Try the next known project root. */ }
    }
    if (!source) throw new Error('macos-notifications.swift is missing from the WorkLite release');
    const directory = join(dirname(resolve(process.env.SQLITE_PATH || join(root, '.data/worklite.db'))), 'host-notifications');
    const app = join(directory, APP_NAME);
    const executable = join(app, 'Contents/MacOS', EXECUTABLE);
    const fingerprint = createHash('sha256').update(source).update(`v3:${process.arch}`).digest('hex');
    try {
      if ((await readFile(join(directory, 'version'), 'utf8')) === fingerprint) {
        await access(executable);
        return { executable, directory };
      }
    } catch { /* Build or repair a missing helper automatically. */ }
    await mkdir(directory, { recursive: true });
    const build = await mkdtemp(join(directory, '.build-'));
    try {
      const contents = join(build, APP_NAME, 'Contents');
      await mkdir(join(contents, 'MacOS'), { recursive: true });
      const swift = join(build, 'main.swift');
      await writeFile(swift, source);
      await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string><key>CFBundleName</key><string>WorkLite 通知</string><key>CFBundleDisplayName</key><string>WorkLite 通知</string><key>CFBundleExecutable</key><string>${EXECUTABLE}</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/><key>LSMinimumSystemVersion</key><string>12.0</string><key>NSUserNotificationAlertStyle</key><string>banner</string></dict></plist>`);
      await this.command('/usr/bin/xcrun', ['swiftc', swift, '-O', '-swift-version', '5', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx12.0`, '-module-cache-path', join(directory, 'modules'), '-o', join(contents, 'MacOS', EXECUTABLE)], 120_000);
      await this.command('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', BUNDLE_ID,
        '--requirements', `=designated => identifier "${BUNDLE_ID}"`, join(build, APP_NAME)], 10_000);
      await rm(app, { recursive: true, force: true });
      await rename(join(build, APP_NAME), app);
      await this.command('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app], 10_000);
      await writeFile(join(directory, 'version'), fingerprint);
      return { executable, directory };
    } finally { await rm(build, { recursive: true, force: true }); }
  }

  async send(payload: Record<string, string>): Promise<NativeNotificationResult> {
    const { executable } = await this.prepare();
    return JSON.parse(await this.command(executable, [], 65_000, JSON.stringify(payload))) as NativeNotificationResult;
  }

  async guide(reason: 'authorization' | 'focus'): Promise<void> {
    const { executable, directory } = await this.prepare();
    try { await writeFile(join(directory, `guided-${reason}`), new Date().toISOString(), { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
    try { await this.command(executable, ['--guide', reason], 120_000); }
    catch (error) {
      // An unanswered guide was already shown once. A launch failure should retry.
      if (error instanceof Error && error.message.includes('timed out')) return;
      await rm(join(directory, `guided-${reason}`), { force: true });
      throw error;
    }
  }
}

export function notificationPresentation(output: string, id: string): 'presented' | 'suppressed' | 'unknown' {
  const rows = JSON.parse(output) as Array<{ eventMessage?: string }>;
  const all = rows.map((row) => row.eventMessage ?? '');
  // NotificationCenter renders its internal short record ids, not the request UUID.
  // Correlate them through the daemon's NotificationRecord before judging visibility.
  const aliases = new Set([id]);
  for (const message of all.filter((line) => line.includes(id))) {
    for (const match of message.matchAll(/(?:ident|uuid):"([^"]+)"/g)) aliases.add(match[1]!);
  }
  const messages = all.filter((message) => [...aliases].some((alias) => message.includes(alias)));
  if (messages.some((message) => /muted by DND|interruptionSuppression: silence|canDisplayWhileCenterIsClosed: false/.test(message))) return 'suppressed';
  if (messages.some((message) => /canDisplayWhileCenterIsClosed: true/.test(message))) return 'presented';
  return 'unknown';
}
