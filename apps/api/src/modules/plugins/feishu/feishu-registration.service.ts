import { BadRequestException, Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FeishuRegistrationView } from '@worklite/contracts';
import { feishuRegistrations, plugins, type Database } from '@worklite/db';
import { DATABASE } from '../../../infrastructure/database.module';
import { assertRuntimeAdmission, runtimeAdmissionClosed } from '../../../infrastructure/runtime-upgrade-state';
import { decryptSecret, encryptSecret, FEISHU_PLUGIN_ID, PluginsService } from '../plugins.service';
import { FeishuService } from './feishu.service';

// Protocol reference: larksuite/cli internal/auth/app_registration.go at
// 7beffb086d7fa3c5b843d8affa7c089f49cfc65e (MIT, Lark Technologies Pte. Ltd.).
const registrationEndpoint = 'https://accounts.feishu.cn/oauth/v1/app/registration';
type Registration = typeof feishuRegistrations.$inferSelect;
type Payload = {
  error?: string;
  device_code?: string;
  user_code?: string;
  expire_in?: number;
  interval?: number;
  client_id?: string;
  client_secret?: string;
  user_info?: { open_id?: string; tenant_brand?: string };
};

@Injectable()
export class FeishuRegistrationService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private startWork?: Promise<FeishuRegistrationView>;
  private polling = false;
  private stopped = false;
  private requestAbort?: AbortController;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly configuration: PluginsService,
    private readonly feishu: FeishuService,
  ) {}

  onModuleInit(): void {
    if (process.env.WORKLITE_PREFLIGHT === '1') return;
    this.timer = setInterval(() => { void this.work().catch(() => undefined); }, 1_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.requestAbort?.abort();
  }

  upgradeQuiescent(): boolean { return !this.startWork && !this.polling; }

  async start(): Promise<FeishuRegistrationView> {
    assertRuntimeAdmission();
    if (this.startWork) return this.startWork;
    this.startWork = this.begin();
    try { return await this.startWork; } finally { this.startWork = undefined; }
  }

  async cancel(): Promise<void> {
    assertRuntimeAdmission();
    // A manual save/cancellation owns the outcome even if begin is still in flight.
    await this.startWork?.catch(() => undefined);
    assertRuntimeAdmission();
    const registration = await this.latest();
    if (registration?.status === 'pending') await this.finish(registration, 'cancelled');
  }

  async cancelForUpgrade(): Promise<void> {
    this.requestAbort?.abort();
    const registration = await this.latest();
    if (registration?.status === 'pending') await this.finish(registration, 'cancelled');
  }

  async completeManualBinding(): Promise<void> {
    const [configuration] = await this.db.select().from(plugins).where(eq(plugins.id, FEISHU_PLUGIN_ID)).limit(1);
    if (!configuration?.feishuAllowedUserId) return;
    await this.db.update(feishuRegistrations).set({ status: 'completed', updatedAt: new Date() })
      .where(and(eq(feishuRegistrations.pluginId, FEISHU_PLUGIN_ID), eq(feishuRegistrations.status, 'needs_user_id')));
  }

  private async begin(): Promise<FeishuRegistrationView> {
    await this.configuration.get(FEISHU_PLUGIN_ID);
    const current = await this.latest();
    if (current?.status === 'pending' && current.expiresAt && current.expiresAt.getTime() > Date.now()) return view(current);
    if (current?.status === 'pending') await this.finish(current, 'expired');
    let response: { ok: boolean; data: Payload };
    try {
      response = await this.request({ action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id tenant_brand' }, 30_000);
    } catch {
      throw new BadRequestException('无法申请飞书应用注册，请重试。');
    }
    const { data } = response;
    if (!response.ok || data.error || !data.device_code || !data.user_code) throw new BadRequestException('飞书未返回有效的应用注册信息，请重试。');
    const now = new Date();
    const registration: Registration = {
      pluginId: FEISHU_PLUGIN_ID, id: randomUUID(), status: 'pending',
      deviceCode: encryptSecret(data.device_code),
      verificationUrl: `https://open.feishu.cn/page/cli?user_code=${data.user_code}`,
      expiresAt: new Date(now.getTime() + positive(data.expire_in, 600) * 1_000),
      intervalSeconds: positive(data.interval, 5), nextPollAt: now,
      error: null, createdAt: now, updatedAt: now,
    };
    if (this.stopped) throw new BadRequestException('服务正在关闭，请稍后重新申请。');
    await this.db.insert(feishuRegistrations).values(registration)
      .onConflictDoUpdate({ target: feishuRegistrations.pluginId, set: registration });
    return view(registration);
  }

  private async latest(): Promise<Registration | undefined> {
    const [registration] = await this.db.select().from(feishuRegistrations).where(eq(feishuRegistrations.pluginId, FEISHU_PLUGIN_ID)).limit(1);
    return registration;
  }

  private async work(): Promise<void> {
    if (this.stopped || this.polling || this.startWork || runtimeAdmissionClosed()) return;
    this.polling = true;
    try {
      const registration = await this.latest();
      if (!registration || registration.status !== 'pending') return;
      const remaining = (registration.expiresAt?.getTime() ?? 0) - Date.now();
      if (remaining <= 0) { await this.finish(registration, 'expired'); return; }
      if ((registration.nextPollAt?.getTime() ?? 0) > Date.now()) return;
      let response: { ok: boolean; data: Payload };
      try {
        response = await this.request({ action: 'poll', device_code: decryptSecret(registration.deviceCode!) }, Math.min(30_000, remaining));
      } catch {
        if (!this.stopped) await this.schedule(registration, Math.min(registration.intervalSeconds + 1, 60));
        return;
      }
      if (this.stopped) return;
      if (Date.now() >= registration.expiresAt!.getTime()) { await this.finish(registration, 'expired'); return; }
      const { data } = response;
      if (data.user_info?.tenant_brand && data.user_info.tenant_brand !== 'feishu') {
        await this.finish(registration, 'error', '当前仅支持飞书企业，请重新选择飞书企业或配置已有飞书应用。');
        return;
      }
      switch (data.error) {
        case 'authorization_pending': await this.schedule(registration); return;
        case 'slow_down': await this.schedule(registration, Math.min(registration.intervalSeconds + 5, 60)); return;
        case 'access_denied': await this.finish(registration, 'denied'); return;
        case 'expired_token': case 'invalid_grant': await this.finish(registration, 'expired'); return;
      }
      if (data.error || !response.ok) {
        await this.finish(registration, 'error', '飞书应用注册失败，请重新申请或配置已有应用。');
        return;
      }
      if (!data.client_id || !data.client_secret) { await this.schedule(registration); return; }
      const openId = data.user_info?.open_id ?? '';
      const stored = this.db.transaction((transaction) => {
        const changed = transaction.update(feishuRegistrations).set({
          status: openId ? 'completed' : 'needs_user_id', deviceCode: null,
          verificationUrl: null, nextPollAt: null, error: null, updatedAt: new Date(),
        }).where(pending(registration)).run();
        if (!changed.changes) return false;
        transaction.update(plugins).set({
          feishuAppId: data.client_id!, feishuAppSecret: encryptSecret(data.client_secret!),
          feishuAllowedUserId: openId, feishuEnabled: Boolean(openId),
          feishuStatus: openId ? 'connecting' : 'disconnected', feishuLastError: null, updatedAt: new Date(),
        }).where(eq(plugins.id, FEISHU_PLUGIN_ID)).run();
        return true;
      });
      if (stored) await this.feishu.connect();
    } finally { this.polling = false; }
  }

  private async schedule(registration: Registration, interval = registration.intervalSeconds): Promise<void> {
    await this.db.update(feishuRegistrations).set({ intervalSeconds: interval, nextPollAt: new Date(Date.now() + interval * 1_000), updatedAt: new Date() }).where(pending(registration));
  }

  private async finish(registration: Registration, status: Registration['status'], error: string | null = null): Promise<void> {
    await this.db.update(feishuRegistrations).set({ status, deviceCode: null, verificationUrl: null, nextPollAt: null, error, updatedAt: new Date() }).where(pending(registration));
  }

  private async request(form: Record<string, string>, timeout: number): Promise<{ ok: boolean; data: Payload }> {
    const abort = new AbortController();
    this.requestAbort = abort;
    const timer = setTimeout(() => abort.abort(), timeout);
    try {
      const response = await fetch(registrationEndpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form), signal: abort.signal,
      });
      return { ok: response.ok, data: await response.json() as Payload };
    } finally {
      clearTimeout(timer);
      if (this.requestAbort === abort) this.requestAbort = undefined;
    }
  }
}

function pending(registration: Registration) {
  return and(eq(feishuRegistrations.id, registration.id), eq(feishuRegistrations.status, 'pending'));
}

function positive(value: number | undefined, defaultValue: number): number {
  return typeof value === 'number' && value > 0 ? value : defaultValue;
}

function view(registration: Registration): FeishuRegistrationView {
  return { id: registration.id, status: registration.status, verificationUrl: registration.verificationUrl, expiresAt: registration.expiresAt?.toISOString() ?? null, error: registration.error };
}
