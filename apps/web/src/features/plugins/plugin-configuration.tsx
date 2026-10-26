import { LoaderCircle, LogIn, Puzzle, Unplug } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { pluginsQueryKey, usePluginQuery } from '@/api/queries';
import { PageHeading } from '@/components/page-heading';
import { SaveIndicator } from '@/components/save-indicator';
import { StatusBadge } from '@/components/status-badge';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { queryClient } from '@/lib/query-client';

export function PluginConfiguration({ pluginId, embedded = false }: { pluginId: string; embedded?: boolean }) {
  const { t: tPlugins } = useTranslation('plugins');
  const { t: tCommon } = useTranslation('common');
  const { t: tChat } = useTranslation('assistant');
  const pluginQuery = usePluginQuery(pluginId);
  const plugin = pluginQuery.data;
  const [command, setCommand] = useState('');
  const [codexConfigPath, setCodexConfigPath] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<'idle' | 'pending' | 'available' | 'missing' | 'failed'>('idle');
  const [error, setError] = useState('');
  const [connectionPending, setConnectionPending] = useState(false);
  const [feishuAppId, setFeishuAppId] = useState('');
  const [feishuAppSecret, setFeishuAppSecret] = useState('');
  const [feishuUserId, setFeishuUserId] = useState('');
  const [registrationBusy, setRegistrationBusy] = useState<'starting' | 'cancelling' | null>(null);
  const [registrationError, setRegistrationError] = useState('');
  const [registrationQr, setRegistrationQr] = useState('');
  const [qrFailed, setQrFailed] = useState(false);
  const [wechatUserId, setWechatUserId] = useState('');
  const [wechatLoginBusy, setWechatLoginBusy] = useState<'starting' | 'cancelling' | null>(null);
  const [wechatLoginError, setWechatLoginError] = useState('');
  const [wechatQr, setWechatQr] = useState('');
  const [wechatQrFailed, setWechatQrFailed] = useState(false);
  const wechatLogin = plugin?.wechat?.login ?? null;
  const wechatLoginOpen = wechatLogin?.status === 'pending' || wechatLogin?.status === 'scanned';
  const registration = plugin?.feishu?.registration;
  const registrationPending = registration?.status === 'pending';
  const registrationSavedId = registration?.status === 'completed' || registration?.status === 'needs_user_id' ? registration.id : null;
  const [qrExpiryTick, setQrExpiryTick] = useState(0);
  useEffect(() => {
    if (!plugin) return;
    setCommand(plugin.command);
    setCodexConfigPath(plugin.codexConfigPath ?? '');
    setFeishuAppId(plugin.feishu?.appId ?? '');
    setFeishuUserId(plugin.feishu?.allowedUserId ?? '');
    setWechatUserId(plugin.wechat?.allowedUserId ?? '');
    setFeishuAppSecret('');
    setTestState(plugin.status);
    setSaveState('saved');
    setError('');
  }, [plugin?.id, plugin?.command, plugin?.codexConfigPath, plugin?.feishu?.appId, plugin?.feishu?.allowedUserId, plugin?.wechat?.allowedUserId]); // eslint-disable-line react-hooks/exhaustive-deps -- unrelated status changes must not erase a typed secret.

  useEffect(() => {
    if (!registrationSavedId) return;
    setFeishuAppSecret(''); setSaveState('saved');
  }, [registrationSavedId]);

  useEffect(() => {
    setRegistrationQr(''); setQrFailed(false);
    if (!registration?.verificationUrl || !registrationPending) return;
    let cancelled = false;
    void QRCode.toDataURL(registration.verificationUrl).then((source) => {
      if (!cancelled) setRegistrationQr(source);
    }).catch(() => { if (!cancelled) setQrFailed(true); });
    return () => { cancelled = true; };
  }, [registration?.verificationUrl, registrationPending]);

  useEffect(() => {
    setWechatQr(''); setWechatQrFailed(false);
    if (!wechatLogin?.qrCodeUrl || !wechatLoginOpen) return;
    let cancelled = false;
    void QRCode.toDataURL(wechatLogin.qrCodeUrl).then((source) => {
      if (!cancelled) setWechatQr(source);
    }).catch(() => { if (!cancelled) setWechatQrFailed(true); });
    return () => { cancelled = true; };
  }, [wechatLogin?.qrCodeUrl, wechatLoginOpen]);

  async function startWechatLogin() {
    if (wechatLoginBusy) return;
    setWechatLoginBusy('starting'); setWechatLoginError('');
    try {
      const login = await api.startWechatLogin(pluginId);
      await queryClient.cancelQueries({ queryKey: ['plugin', pluginId] });
      queryClient.setQueryData(['plugin', pluginId], (current: typeof plugin) => current?.wechat ? { ...current, wechat: { ...current.wechat, login } } : current);
      void queryClient.invalidateQueries({ queryKey: ['plugin', pluginId] });
    } catch (cause) {
      setWechatLoginError(cause instanceof Error ? cause.message : tPlugins('wechat.loginFailed'));
    } finally { setWechatLoginBusy(null); }
  }

  async function cancelWechatLogin() {
    if (wechatLoginBusy) return;
    setWechatLoginBusy('cancelling'); setWechatLoginError('');
    try {
      const saved = await api.cancelWechatLogin(pluginId);
      await queryClient.cancelQueries({ queryKey: ['plugin', pluginId] });
      queryClient.setQueryData(['plugin', pluginId], saved);
    } catch (cause) {
      setWechatLoginError(cause instanceof Error ? cause.message : tPlugins('wechat.cancelFailed'));
    } finally { setWechatLoginBusy(null); }
  }

  async function disconnectWechat() {
    setConnectionPending(true); setError('');
    try {
      const saved = await api.disconnectWechat(pluginId);
      queryClient.setQueryData(['plugin', pluginId], saved);
    } catch (cause) { setError(cause instanceof Error ? cause.message : tPlugins('wechat.disconnectFailed')); }
    finally { setConnectionPending(false); }
  }

  async function saveWechat() {
    if (saving || !wechatUserId.trim()) return;
    setSaving(true); setError('');
    try {
      const saved = await api.updatePlugin(pluginId, { wechat: { allowedUserId: wechatUserId.trim() } });
      queryClient.setQueryData(['plugin', pluginId], saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tPlugins('config.saveFailed'));
    } finally { setSaving(false); }
  }

  async function startFeishuRegistration() {
    if (registrationBusy) return;
    setRegistrationBusy('starting'); setRegistrationError('');
    try {
      const next = await api.startFeishuRegistration();
      await queryClient.cancelQueries({ queryKey: ['plugin', pluginId] });
      queryClient.setQueryData(['plugin', pluginId], (current: typeof plugin) => current?.feishu ? { ...current, feishu: { ...current.feishu, registration: next } } : current);
      void queryClient.invalidateQueries({ queryKey: ['plugin', pluginId] });
    } catch (cause) {
      setRegistrationError(cause instanceof Error ? cause.message : tPlugins('feishu.registration.requestFailed'));
    } finally { setRegistrationBusy(null); }
  }

  async function cancelFeishuRegistration() {
    if (registrationBusy) return;
    setRegistrationBusy('cancelling'); setRegistrationError('');
    try {
      const saved = await api.cancelFeishuRegistration();
      await queryClient.cancelQueries({ queryKey: ['plugin', pluginId] });
      queryClient.setQueryData(['plugin', pluginId], saved);
    } catch (cause) {
      setRegistrationError(cause instanceof Error ? cause.message : tPlugins('feishu.registration.cancelFailed'));
    } finally { setRegistrationBusy(null); }
  }

  const replacedFeishuQrRef = useRef('');
  const startFeishuRegistrationRef = useRef(startFeishuRegistration);
  useEffect(() => { startFeishuRegistrationRef.current = startFeishuRegistration; });
  useEffect(() => {
    const becameVisible = () => { if (document.visibilityState === 'visible') setQrExpiryTick((tick) => tick + 1); };
    document.addEventListener('visibilitychange', becameVisible);
    return () => document.removeEventListener('visibilitychange', becameVisible);
  }, []);
  useEffect(() => {
    if (!registration || !['pending', 'expired'].includes(registration.status) || registrationBusy || document.visibilityState !== 'visible') return;
    const remaining = registration.status === 'expired' ? 0 : Date.parse(registration.expiresAt ?? '') - Date.now();
    if (remaining > 0) {
      const timer = window.setTimeout(() => setQrExpiryTick((tick) => tick + 1), remaining + 250);
      return () => window.clearTimeout(timer);
    }
    if (replacedFeishuQrRef.current === registration.id) return;
    replacedFeishuQrRef.current = registration.id;
    void startFeishuRegistrationRef.current();
    // Registration identity, expiry, busy state, and visibility drive this replacement timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registration?.id, registration?.status, registration?.expiresAt, registrationBusy, qrExpiryTick]);

  async function save() {
    if (!command.trim() || saving) return null;
    setSaving(true);
    setSaveState('saving');
    setError('');
    try {
      const saved = await api.updatePlugin(pluginId, {
        command: command.trim(),
        ...(pluginId === 'codex-cli-chat' ? { codexConfigPath: codexConfigPath.trim() } : {}),
      });
      queryClient.setQueryData(['plugin', pluginId], saved);
      void queryClient.invalidateQueries({ queryKey: pluginsQueryKey() }).catch(() => undefined);
      setSaveState('saved');
      toast.success(tPlugins('config.saved'));
      return saved;
    } catch (cause) {
      setSaveState('unsaved');
      setError(cause instanceof Error ? cause.message : tPlugins('config.saveFailed'));
      return null;
    } finally {
      setSaving(false);
    }
  }

  // Saving a command is only useful if the command runs, so Save verifies it rather
  // than leaving a second control to confirm what was just saved. Persistence and
  // availability are reported separately: the command is stored either way.
  async function saveAndVerify() {
    const saved = await save();
    if (!saved) {
      setTestState('idle');
      return;
    }
    setTestState('pending');
    try {
      const result = await api.testPlugin(pluginId);
      setTestState(result.status);
      queryClient.setQueryData(['plugin', pluginId], { ...saved, enabled: result.enabled, status: result.status });
      void queryClient.invalidateQueries({ queryKey: pluginsQueryKey() }).catch(() => undefined);
    } catch (cause) {
      setTestState('failed');
      setError(cause instanceof Error ? cause.message : tPlugins('config.testFailed'));
    }
  }

  async function saveFeishu() {
    if (saving || registrationPending || registrationBusy || !feishuAppId.trim() || !feishuUserId.trim()) return;
    setSaving(true); setSaveState('saving'); setError('');
    try {
      const saved = await api.updatePlugin(pluginId, { feishu: { appId: feishuAppId.trim(), allowedUserId: feishuUserId.trim(), ...(feishuAppSecret.trim() ? { appSecret: feishuAppSecret.trim() } : {}) } });
      queryClient.setQueryData(['plugin', pluginId], saved);
      void queryClient.invalidateQueries({ queryKey: pluginsQueryKey() });
      setFeishuAppSecret(''); setSaveState('saved');
    } catch (cause) {
      setSaveState('unsaved'); setError(cause instanceof Error ? cause.message : tPlugins('config.saveFailed'));
    } finally { setSaving(false); }
  }

  async function disconnectFeishu() {
    setConnectionPending(true); setError('');
    try {
      const saved = await api.disconnectFeishu();
      queryClient.setQueryData(['plugin', pluginId], saved);
    } catch (cause) { setError(cause instanceof Error ? cause.message : tPlugins('feishu.disconnectFailed')); }
    finally { setConnectionPending(false); }
  }

  async function startOfficialAccountLogin() {
    setConnectionPending(true);
    setError('');
    try {
      const officialAccount = await api.startOfficialAccountLogin(pluginId);
      queryClient.setQueryData(['plugin', pluginId], { ...plugin, officialAccount });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tPlugins('officialAccount.loginFailed'));
    } finally { setConnectionPending(false); }
  }

  // The Official Account QR carries a server-reported expiry, so a stale code is
  // replaced without asking. Each expiry marker is attempted once so an equally
  // stale response cannot spin. Each replacement is owned by the Official Account connection.
  const officialAccountStatus = plugin?.officialAccount?.status ?? null;
  const officialAccountExpiresAt = plugin?.officialAccount?.qrExpiresAt ?? null;
  const replacedOfficialQrRef = useRef('');
  const startOfficialAccountLoginRef = useRef(startOfficialAccountLogin);

  useEffect(() => {
    startOfficialAccountLoginRef.current = startOfficialAccountLogin;
  });

  useEffect(() => {
    if (officialAccountStatus !== 'qr_pending' || officialAccountExpiresAt === null) return;
    const remaining = Date.parse(officialAccountExpiresAt) - Date.now();
    const marker = officialAccountExpiresAt;
    if (remaining > 0) {
      const timer = window.setTimeout(() => setQrExpiryTick((value) => value + 1), remaining + 250);
      return () => window.clearTimeout(timer);
    }
    if (replacedOfficialQrRef.current === marker) return;
    replacedOfficialQrRef.current = marker;
    void startOfficialAccountLoginRef.current();
  }, [officialAccountStatus, officialAccountExpiresAt, qrExpiryTick]);

  async function disconnectOfficialAccount() {
    setConnectionPending(true);
    setError('');
    try {
      const officialAccount = await api.disconnectOfficialAccount(pluginId);
      queryClient.setQueryData(['plugin', pluginId], { ...plugin, officialAccount });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tPlugins('officialAccount.disconnectFailed'));
    } finally { setConnectionPending(false); }
  }

  if (pluginQuery.isLoading) return <div className="space-y-4 p-4" role="status" aria-label={embedded ? tChat('channels.loading') : tPlugins('loading')}><div className="h-10 animate-pulse rounded bg-surface-subtle motion-reduce:animate-none" /><div className="h-32 animate-pulse rounded bg-surface-subtle motion-reduce:animate-none" /></div>;
  if (!plugin) return <div className="mx-auto w-full max-w-[840px] px-4 py-6 md:px-6 md:py-8"><p className="text-sm text-danger" role="alert">{embedded ? tChat('channels.loadFailed') : tPlugins('loadFailed')}</p><Button className="mt-4" variant="secondary" onClick={() => void pluginQuery.refetch()}>{tCommon('actions.retry')}</Button></div>;

  const feishuManualSave = pluginId === 'feishu-bot' && (saveState !== 'saved' || registration?.status === 'needs_user_id') && !registrationPending && !registrationBusy;
  const secretAvailable = Boolean(feishuAppSecret.trim() || plugin.feishu?.hasAppSecret && feishuAppId.trim() === plugin.feishu.appId);

  return (
    <div className={embedded ? "w-full max-w-[840px] p-4 sm:p-6" : "mx-auto w-full max-w-[840px] px-4 py-6 md:px-6 md:py-8"}>
      {embedded ? <div className="flex items-center justify-between gap-3">{!registrationPending && (plugin.feishu?.hasAppSecret || saveState !== 'saved') ? <SaveIndicator state={saveState} /> : <span />}{feishuManualSave ? <Button size="compact" onClick={() => void saveFeishu()} disabled={saving || !feishuAppId.trim() || !feishuUserId.trim() || !secretAvailable}>{saving ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : null}{tCommon('actions.save')}</Button> : null}</div> : (<WorkspaceChrome crumbs={[{ label: tPlugins('title'), to: '/plugins' }, { label: plugin.name }]} status={pluginId === 'codex-cli-chat' || pluginId === 'feishu-bot' && !registrationPending && (plugin.feishu?.hasAppSecret || saveState !== 'saved') ? <SaveIndicator state={saveState} /> : undefined} actions={pluginId === 'codex-cli-chat' || feishuManualSave ? <Button size="compact" onClick={() => void (pluginId === 'feishu-bot' ? saveFeishu() : saveAndVerify())} disabled={saving || (pluginId === 'feishu-bot' ? !feishuAppId.trim() || !feishuUserId.trim() || !secretAvailable : testState === 'pending' || !command.trim())}>{saving ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : null}{tCommon('actions.save')}</Button> : undefined} />)}
      {embedded ? null : <PageHeading title={plugin.name} description={plugin.description} />}
      <div className="mt-6 space-y-5">
        {pluginId === 'codex-cli-chat' ? <><div className="flex items-center gap-2 text-sm font-medium"><Puzzle className="size-4 text-muted-foreground" aria-hidden="true" />{tPlugins('config.title')}</div><p className="text-[13px] text-muted-foreground">{tPlugins('config.description')}</p></> : null}
        {pluginQuery.isError ? <p className="text-[13px] text-danger" role="alert">{embedded ? tChat('channels.loadFailed') : tPlugins('loadFailed')}</p> : null}
        {error ? <p className="text-[13px] text-danger" role="alert">{error}</p> : null}
        {pluginId === 'codex-cli-chat' ? <><Field label={tPlugins('config.command')} htmlFor="plugin-command" hint={tPlugins('config.commandHint')}>
          <Input id="plugin-command" value={command} placeholder={tPlugins('config.commandPlaceholder')} onChange={(event) => { setCommand(event.target.value); setSaveState('unsaved'); setTestState('idle'); }} autoComplete="off" />
        </Field>
        <Field label={tPlugins('config.codexConfigPath')} htmlFor="codex-config-path" hint={tPlugins('config.codexConfigPathHint')}>
          <Input id="codex-config-path" value={codexConfigPath} placeholder={tPlugins('config.codexConfigPathPlaceholder')} onChange={(event) => { setCodexConfigPath(event.target.value); setSaveState('unsaved'); }} autoComplete="off" />
        </Field>
        {testState === 'idle' ? null : (
          <div className="flex flex-wrap items-center gap-3">
            {testState === 'pending' ? (
              <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground" role="status">
                <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                {tPlugins('config.verifying')}
              </span>
            ) : (
              <StatusBadge status={testState} />
            )}
          </div>
        )}</> : null}
        {pluginId === 'feishu-bot' && plugin.feishu ? (
          <section className="space-y-4" aria-labelledby="feishu-heading">
            <h2 id="feishu-heading" className="text-sm font-medium">{tPlugins('feishu.title')}</h2>
            <div className="space-y-3">
              <p className="text-[13px] text-muted-foreground">{tPlugins(plugin.feishu.hasAppSecret ? 'feishu.registration.replaceConstraint' : 'feishu.registration.constraint')}</p>
              {registrationPending && registrationBusy !== 'starting' ? (
                <div className="space-y-3">
                  {registrationQr ? <img src={registrationQr} alt={tPlugins('feishu.registration.qrAlt')} className="size-48 rounded border border-border bg-white object-contain p-2" /> : null}
                  {registration.verificationUrl ? <a href={registration.verificationUrl} target="_blank" rel="noreferrer" className="inline-block text-sm text-brand-text underline underline-offset-4">{tPlugins('feishu.registration.open')}</a> : null}
                  {qrFailed ? <p className="text-[13px] text-danger" role="alert">{tPlugins('feishu.registration.qrFailed')}</p> : null}
                </div>
              ) : null}
              {registrationBusy === 'starting' || registration ? <p className="text-sm" role="status" aria-live="polite">{tPlugins(registrationBusy === 'starting' ? 'feishu.registration.starting' : `feishu.registration.status.${registration!.status}`)}</p> : null}
              {registration?.error || registrationError ? <p className="text-[13px] text-danger" role="alert">{registrationError || registration?.error}</p> : null}
              {registrationPending && registrationBusy !== 'starting' ? <Button type="button" variant="ghost" onClick={() => void cancelFeishuRegistration()} disabled={Boolean(registrationBusy)}>{registrationBusy === 'cancelling' ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : null}{tPlugins('feishu.registration.cancel')}</Button> : <Button type="button" onClick={() => void startFeishuRegistration()} disabled={Boolean(registrationBusy) || saving || connectionPending}>{registrationBusy === 'starting' ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : null}{tPlugins(plugin.feishu.hasAppSecret ? 'feishu.registration.replace' : 'feishu.registration.create')}</Button>}
            </div>
            <p className="text-[13px] text-muted-foreground">{tPlugins('feishu.registration.platformRequirements')}</p>
            <a href={plugin.feishu.appId ? `https://open.feishu.cn/app/${encodeURIComponent(plugin.feishu.appId)}` : 'https://open.feishu.cn/app'} target="_blank" rel="noreferrer" className="text-sm text-brand-text underline underline-offset-4">{tPlugins('feishu.openPlatform')}</a>
            <fieldset className="space-y-4" disabled={registrationPending || Boolean(registrationBusy) || saving}>
              <legend className="mb-3 text-sm font-medium">{tPlugins('feishu.registration.manual')}</legend>
              <Field label={tPlugins('feishu.appId')} htmlFor="feishu-app-id"><Input id="feishu-app-id" value={feishuAppId} autoComplete="off" onChange={(event) => { setFeishuAppId(event.target.value); setSaveState('unsaved'); }} /></Field>
              <Field label={tPlugins('feishu.appSecret')} htmlFor="feishu-app-secret"><Input id="feishu-app-secret" type="password" value={feishuAppSecret} autoComplete="new-password" placeholder={plugin.feishu.hasAppSecret && feishuAppId === plugin.feishu.appId ? tPlugins('feishu.secretConfigured') : undefined} onChange={(event) => { setFeishuAppSecret(event.target.value); setSaveState('unsaved'); }} /></Field>
              <Field label={tPlugins('feishu.allowedUserId')} htmlFor="feishu-user-id"><Input id="feishu-user-id" value={feishuUserId} autoComplete="off" onChange={(event) => { setFeishuUserId(event.target.value); setSaveState('unsaved'); }} /></Field>
            </fieldset>
            <div role="status"><StatusBadge key={plugin.feishu.status} status={plugin.feishu.status === 'connecting' ? 'starting' : plugin.feishu.status} label={tPlugins(`feishu.status.${plugin.feishu.status}`)} /></div>
            {plugin.feishu.lastError ? <p className="text-[13px] text-danger" role="alert">{plugin.feishu.lastError}</p> : null}
            {plugin.feishu.status !== 'disconnected' ? <Button type="button" variant="ghost" disabled={connectionPending || registrationPending || Boolean(registrationBusy) || saving} onClick={() => void disconnectFeishu()}>{connectionPending ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <Unplug aria-hidden="true" />}{tPlugins('feishu.disconnect')}</Button> : null}
          </section>
        ) : null}
        {pluginId === 'wechat-bot' && plugin.wechat ? (
          <section className="space-y-4" aria-labelledby="wechat-heading">
            <h2 id="wechat-heading" className="text-sm font-medium">{tPlugins('wechat.title')}</h2>
            <p className="text-[13px] text-muted-foreground">{tPlugins('wechat.description')}</p>
            <div role="status"><StatusBadge key={plugin.wechat.status} status={plugin.wechat.status === 'connecting' ? 'starting' : plugin.wechat.status} label={tPlugins(`wechat.status.${plugin.wechat.status}`)} /></div>
            {plugin.wechat.lastError ? <p className="text-[13px] text-danger" role="alert">{plugin.wechat.lastError}</p> : null}
            {wechatLoginOpen && wechatLogin ? (
              <div className="space-y-3">
                {wechatQr ? <img src={wechatQr} alt={tPlugins('wechat.qrAlt')} className="size-48 rounded border border-border bg-white object-contain p-2" /> : null}
                {wechatQrFailed ? <p className="text-[13px] text-danger" role="alert">{tPlugins('wechat.qrFailed')}</p> : null}
                <p className="text-sm" role="status" aria-live="polite">{tPlugins(`wechat.loginStatus.${wechatLogin.status}`)}</p>
                <Button type="button" variant="ghost" onClick={() => void cancelWechatLogin()} disabled={Boolean(wechatLoginBusy)}>{wechatLoginBusy === 'cancelling' ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : null}{tPlugins('wechat.cancel')}</Button>
              </div>
            ) : (
              <div className="space-y-3">
                {wechatLogin?.status === 'expired' || wechatLogin?.status === 'error' ? <p className="text-[13px] text-danger" role="alert">{wechatLogin.error ?? tPlugins(`wechat.loginStatus.${wechatLogin.status}`)}</p> : null}
                {wechatLoginError ? <p className="text-[13px] text-danger" role="alert">{wechatLoginError}</p> : null}
                <div className="flex flex-wrap gap-3">
                  <Button type="button" onClick={() => void startWechatLogin()} disabled={Boolean(wechatLoginBusy) || connectionPending || saving}>{wechatLoginBusy === 'starting' ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <LogIn aria-hidden="true" />}{tPlugins(plugin.wechat.hasToken ? 'wechat.relogin' : 'wechat.login')}</Button>
                  {plugin.wechat.status !== 'disconnected' ? <Button type="button" variant="ghost" disabled={connectionPending || Boolean(wechatLoginBusy) || saving} onClick={() => void disconnectWechat()}>{connectionPending ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <Unplug aria-hidden="true" />}{tPlugins('wechat.disconnect')}</Button> : null}
                </div>
              </div>
            )}
            <div className="space-y-2">
              <Field label={tPlugins('wechat.allowedUserId')} htmlFor="wechat-user-id" hint={tPlugins('wechat.allowedUserIdHint')}>
                <Input id="wechat-user-id" value={wechatUserId} autoComplete="off" onChange={(event) => setWechatUserId(event.target.value)} />
              </Field>
              {wechatUserId.trim() !== plugin.wechat.allowedUserId ? <Button size="compact" onClick={() => void saveWechat()} disabled={saving || !wechatUserId.trim()}>{saving ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : null}{tCommon('actions.save')}</Button> : null}
            </div>
          </section>
        ) : null}
        {pluginId === 'wechat-official-account' && plugin.officialAccount ? (
          <section className="space-y-4" aria-labelledby="official-account-heading">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 id="official-account-heading" className="flex items-center gap-2 text-sm font-medium"><Puzzle className="size-4 text-muted-foreground" aria-hidden="true" />{tPlugins('officialAccount.title')}</h2>
                <p className="mt-1 text-[13px] text-muted-foreground">{tPlugins('officialAccount.description')}</p>
              </div>
              <StatusBadge status={plugin.officialAccount.status} />
            </div>
            {plugin.officialAccount.qrCode ? <div className="space-y-2"><img src={plugin.officialAccount.qrCode} alt={tPlugins('officialAccount.qrAlt')} className="size-48 rounded border border-border bg-white object-contain p-2" /><p className="text-[13px] text-muted-foreground">{tPlugins('officialAccount.scan')}</p></div> : null}
            <dl className="grid gap-3 text-[13px] sm:grid-cols-2"><div><dt className="text-muted-foreground">{tPlugins('officialAccount.account')}</dt><dd>{plugin.officialAccount.displayName}</dd></div><div><dt className="text-muted-foreground">{tPlugins('officialAccount.lastVerified')}</dt><dd>{plugin.officialAccount.lastVerifiedAt ?? tPlugins('officialAccount.never')}</dd></div></dl>
            {plugin.officialAccount.lastError ? <p className="text-[13px] text-danger" role="alert">{plugin.officialAccount.lastError}</p> : null}
            <div className="flex flex-wrap gap-3"><Button type="button" variant="secondary" onClick={() => void startOfficialAccountLogin()} disabled={connectionPending || plugin.officialAccount.status === 'connected' || plugin.officialAccount.status === 'qr_pending'}>{connectionPending ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <LogIn aria-hidden="true" />}{tPlugins('officialAccount.login')}</Button>{plugin.officialAccount.status !== 'disconnected' ? <Button type="button" variant="ghost" onClick={() => void disconnectOfficialAccount()} disabled={connectionPending}><Unplug aria-hidden="true" />{tPlugins('officialAccount.disconnect')}</Button> : null}</div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
