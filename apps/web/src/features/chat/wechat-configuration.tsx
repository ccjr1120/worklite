import { LoaderCircle, LogIn, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { useChatChannelConfigurationQuery } from '@/api/queries';
import { queryClient } from '@/lib/query-client';
import { StatusBadge } from '@/components/status-badge';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

const configurationKey = ['chat-channel-configuration', 'wechat'] as const;

export function WechatConfiguration() {
  const { t } = useTranslation('connections');
  const { t: common } = useTranslation('common');
  const query = useChatChannelConfigurationQuery('wechat');
  const connection = query.data?.wechat;
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState<'login' | 'cancel' | 'disconnect' | 'save' | null>(null);
  const [error, setError] = useState('');
  const [qr, setQr] = useState('');
  const [qrFailed, setQrFailed] = useState(false);
  const login = connection?.login;
  const loginOpen = login?.status === 'pending' || login?.status === 'scanned';

  useEffect(() => { setUserId(connection?.allowedUserId ?? ''); }, [connection?.allowedUserId]);
  useEffect(() => {
    setQr(''); setQrFailed(false);
    if (!loginOpen || !login?.qrCodeUrl) return;
    let cancelled = false;
    void QRCode.toDataURL(login.qrCodeUrl).then((source) => { if (!cancelled) setQr(source); })
      .catch(() => { if (!cancelled) setQrFailed(true); });
    return () => { cancelled = true; };
  }, [loginOpen, login?.qrCodeUrl]);

  async function act(action: NonNullable<typeof busy>) {
    if (busy) return;
    setBusy(action); setError('');
    try {
      // Prevent an in-flight poll from replacing a just-created login receipt.
      await queryClient.cancelQueries({ queryKey: configurationKey });
      if (action === 'login') {
        const receipt = await api.startWechatLogin();
        await queryClient.cancelQueries({ queryKey: configurationKey });
        queryClient.setQueryData(configurationKey, (current: typeof query.data) => current?.wechat ? { ...current, wechat: { ...current.wechat, login: receipt } } : current);
      } else {
        const saved = action === 'cancel' ? await api.cancelWechatLogin()
          : action === 'disconnect' ? await api.disconnectWechat()
          : await api.updateChatChannel('wechat', { wechat: { allowedUserId: userId.trim() } });
        await queryClient.cancelQueries({ queryKey: configurationKey });
        queryClient.setQueryData(configurationKey, saved);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t(action === 'login' ? 'wechat.loginFailed' : action === 'cancel' ? 'wechat.cancelFailed' : action === 'disconnect' ? 'wechat.disconnectFailed' : 'saveFailed'));
    } finally {
      setBusy(null);
      void queryClient.invalidateQueries({ queryKey: configurationKey });
    }
  }

  if (query.isLoading) return <p className="p-4 text-sm" role="status">{t('loading')}</p>;
  if (!connection) return <div className="p-4"><p role="alert" className="text-sm text-danger">{t('loadFailed')}</p><Button variant="secondary" onClick={() => void query.refetch()}>{common('actions.retry')}</Button></div>;
  return <section className="w-full max-w-[840px] space-y-4 p-4 sm:p-6" aria-labelledby="wechat-heading">
    <h2 id="wechat-heading" className="text-sm font-medium">{t('wechat.title')}</h2>
    <p className="text-[13px] text-muted-foreground">{t('wechat.description')}</p>
    <StatusBadge status={connection.status === 'connecting' ? 'starting' : connection.status} label={t(`wechat.status.${connection.status}`)} />
    {query.isError ? <p role="alert" className="text-sm text-danger">{t('loadFailed')}</p> : null}
    {connection.lastError || error ? <p role="alert" className="text-sm text-danger">{error || connection.lastError}</p> : null}
    {loginOpen && login ? <div className="space-y-3">
      {qr ? <img src={qr} alt={t('wechat.qrAlt')} className="size-48 rounded border border-border bg-white object-contain p-2" /> : null}
      {qrFailed ? <p role="alert" className="text-sm text-danger">{t('wechat.qrFailed')}</p> : null}
      <p role="status" aria-live="polite" className="text-sm">{t(`wechat.loginStatus.${login.status}`)}</p>
      <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={() => void act('cancel')}>{t('wechat.cancel')}</Button>
    </div> : <div className="space-y-3">
      {login?.status === 'expired' || login?.status === 'error' ? <p role="alert" className="text-sm text-danger">{login.error ?? t(`wechat.loginStatus.${login.status}`)}</p> : null}
      <div className="flex flex-wrap gap-3">
        <Button type="button" disabled={Boolean(busy)} onClick={() => void act('login')}>{busy === 'login' ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <LogIn aria-hidden="true" />}{t(connection.hasToken ? 'wechat.relogin' : 'wechat.login')}</Button>
        {connection.status !== 'disconnected' ? <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={() => void act('disconnect')}><Unplug aria-hidden="true" />{t('wechat.disconnect')}</Button> : null}
      </div>
    </div>}
    <Field label={t('wechat.allowedUserId')} htmlFor="wechat-user-id" hint={t('wechat.allowedUserIdHint')}><Input id="wechat-user-id" value={userId} autoComplete="off" onChange={(event) => setUserId(event.target.value)} /></Field>
    {userId.trim() !== connection.allowedUserId ? <Button type="button" size="compact" disabled={Boolean(busy) || !userId.trim()} onClick={() => void act('save')}>{common('actions.save')}</Button> : null}
  </section>;
}
