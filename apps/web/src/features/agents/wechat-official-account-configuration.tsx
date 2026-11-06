import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { LogIn, Unplug } from 'lucide-react';
import { api } from '@/api/client';
import { queryClient } from '@/lib/query-client';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';

export function WechatOfficialAccountConfiguration({ agentId, parentId }: { agentId: string; parentId?: string }) {
  const { t } = useTranslation('connections');
  const { t: common } = useTranslation('common');
  const key = ['agent-official-account', agentId, parentId] as const;
  const query = useQuery({ queryKey: key, queryFn: () => api.agentOfficialAccount(agentId, parentId), refetchInterval: 2_000 });
  const account = query.data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expiryTick, setExpiryTick] = useState(0);
  const replacedQr = useRef('');

  async function act(action: 'login' | 'disconnect') {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const saved = action === 'login' ? await api.startOfficialAccountLogin(agentId, parentId) : await api.disconnectOfficialAccount(agentId, parentId);
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData(key, saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t(action === 'login' ? 'officialAccount.loginFailed' : 'officialAccount.disconnectFailed'));
    } finally { setBusy(false); }
  }
  const actRef = useRef(act);
  useEffect(() => { actRef.current = act; });
  useEffect(() => {
    if (busy || account?.status !== 'qr_pending' || !account.qrExpiresAt) return;
    const remaining = Date.parse(account.qrExpiresAt) - Date.now();
    if (remaining > 0) {
      const timer = window.setTimeout(() => setExpiryTick((value) => value + 1), remaining + 250);
      return () => window.clearTimeout(timer);
    }
    if (replacedQr.current === account.qrExpiresAt) return;
    replacedQr.current = account.qrExpiresAt;
    void actRef.current('login');
  }, [account?.status, account?.qrExpiresAt, busy, expiryTick]);

  if (query.isLoading) return <p role="status" className="text-sm">{t('loading')}</p>;
  if (!account) return <div><p role="alert" className="text-sm text-danger">{t('loadFailed')}</p><Button type="button" variant="secondary" onClick={() => void query.refetch()}>{common('actions.retry')}</Button></div>;
  return <section className="space-y-4" aria-labelledby="official-account-heading">
    <div className="flex items-center justify-between gap-3"><h2 id="official-account-heading" className="text-sm font-medium">{t('officialAccount.title')}</h2><StatusBadge status={account.status} /></div>
    <p className="text-[13px] text-muted-foreground">{t('officialAccount.description')}</p>
    {account.qrCode ? <div className="space-y-2"><img src={account.qrCode} alt={t('officialAccount.qrAlt')} className="size-48 rounded border border-border bg-white object-contain p-2" /><p className="text-[13px] text-muted-foreground">{t('officialAccount.scan')}</p></div> : null}
    <dl className="grid gap-3 text-[13px] sm:grid-cols-2"><div><dt className="text-muted-foreground">{t('officialAccount.account')}</dt><dd>{account.displayName}</dd></div><div><dt className="text-muted-foreground">{t('officialAccount.lastVerified')}</dt><dd>{account.lastVerifiedAt ?? t('officialAccount.never')}</dd></div></dl>
    {error || account.lastError || query.isError ? <p role="alert" className="text-sm text-danger">{error || account.lastError || t('loadFailed')}</p> : null}
    <div className="flex flex-wrap gap-3">
      <Button type="button" variant="secondary" disabled={busy || account.status === 'connected' || account.status === 'qr_pending'} onClick={() => void act('login')}><LogIn aria-hidden="true" />{t('officialAccount.login')}</Button>
      {account.status !== 'disconnected' ? <Button type="button" variant="ghost" disabled={busy} onClick={() => void act('disconnect')}><Unplug aria-hidden="true" />{t('officialAccount.disconnect')}</Button> : null}
    </div>
  </section>;
}
