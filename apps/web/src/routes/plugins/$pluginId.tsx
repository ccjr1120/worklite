import { createFileRoute, Link } from '@tanstack/react-router';
import { LoaderCircle, LogIn, Puzzle, RefreshCw, RotateCcw, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { pluginsQueryKey, usePluginQuery } from '@/api/queries';
import { AgentResourceNav } from '@/components/agent-resource-nav';
import { PageHeading } from '@/components/page-heading';
import { SaveIndicator } from '@/components/save-indicator';
import { StatusBadge } from '@/components/status-badge';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { queryClient } from '@/lib/query-client';

export const Route = createFileRoute('/plugins/$pluginId')({
  component: PluginConfigPage,
});

function PluginConfigPage() {
  const { t: tPlugins } = useTranslation('plugins');
  const { t: tCommon } = useTranslation('common');
  const { pluginId } = Route.useParams();
  const pluginQuery = usePluginQuery(pluginId);
  const plugin = pluginQuery.data;
  const [command, setCommand] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<'idle' | 'pending' | 'available' | 'missing' | 'failed'>('idle');
  const [error, setError] = useState('');
  const [wechatPending, setWechatPending] = useState(false);
  const [wechatQrImage, setWechatQrImage] = useState<string | null>(null);
  useEffect(() => {
    if (!plugin) return;
    setCommand(plugin.command);
    setTestState(plugin.status);
    setSaveState('saved');
    setError('');
  }, [plugin]);

  useEffect(() => {
    const value = plugin?.wechat.qrCode;
    if (!value) {
      setWechatQrImage(null);
      return;
    }
    if (value.startsWith('data:image/')) {
      setWechatQrImage(value);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(value, { width: 320, margin: 2, errorCorrectionLevel: 'M' })
      .then((image) => { if (!cancelled) setWechatQrImage(image); })
      .catch(() => { if (!cancelled) setWechatQrImage(null); });
    return () => { cancelled = true; };
  }, [plugin?.wechat.qrCode]);

  async function save() {
    if (!command.trim() || saving) return null;
    setSaving(true);
    setSaveState('saving');
    setError('');
    try {
      const saved = await api.updatePlugin(pluginId, { command: command.trim() });
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

  async function test() {
    setError('');
    setTestState('pending');
    const saved = saveState === 'saved' ? plugin : await save();
    if (!saved) {
      setTestState('idle');
      return;
    }
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

  async function startWechatLogin() {
    setWechatPending(true);
    setError('');
    try {
      const wechat = await api.startWechatLogin(pluginId);
      queryClient.setQueryData(['plugin', pluginId], { ...plugin, wechat });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tPlugins('wechat.loginFailed'));
    } finally { setWechatPending(false); }
  }

  async function disconnectWechat() {
    setWechatPending(true);
    setError('');
    try {
      const wechat = await api.disconnectWechat(pluginId);
      queryClient.setQueryData(['plugin', pluginId], { ...plugin, wechat });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tPlugins('wechat.disconnectFailed'));
    } finally { setWechatPending(false); }
  }

  if (pluginQuery.isLoading) return <div className="mx-auto w-full max-w-[840px] px-6 py-6"><p className="text-sm text-muted-foreground">{tPlugins('loading')}</p></div>;
  if (pluginQuery.isError || !plugin) return <div className="mx-auto w-full max-w-[840px] px-6 py-6"><p className="text-sm text-danger" role="alert">{tPlugins('loadFailed')}</p><Button asChild className="mt-4" variant="secondary"><Link to="/plugins">{tCommon('actions.back')}</Link></Button></div>;

  return (
    <div className="mx-auto w-full max-w-[840px] px-6 py-6">
      <WorkspaceChrome crumbs={[{ label: tPlugins('title'), to: '/plugins' }, { label: plugin.name }]} status={<SaveIndicator state={saveState} />} actions={<Button size="compact" onClick={() => void save()} disabled={saving || !command.trim()}>{tCommon('actions.save')}</Button>} />
      <PageHeading title={plugin.name} description={plugin.description} />
      <AgentResourceNav active="plugins" />
      <div className="mt-6 space-y-5">
        <div className="flex items-center gap-2 text-sm font-medium"><Puzzle className="size-4 text-muted-foreground" aria-hidden="true" />{tPlugins('config.title')}</div>
        <p className="text-[13px] text-muted-foreground">{tPlugins('config.description')}</p>
        {error ? <p className="text-[13px] text-danger" role="alert">{error}</p> : null}
        <Field label={tPlugins('config.command')} htmlFor="plugin-command" hint={tPlugins('config.commandHint')}>
          <Input id="plugin-command" value={command} placeholder={tPlugins('config.commandPlaceholder')} onChange={(event) => { setCommand(event.target.value); setSaveState('unsaved'); setTestState('idle'); }} autoComplete="off" />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" onClick={() => void test()} disabled={saving || testState === 'pending' || !command.trim()}>{testState === 'pending' ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}{testState === 'pending' ? tPlugins('config.testing') : tPlugins('config.test')}</Button>
          {testState !== 'idle' && testState !== 'pending' ? <StatusBadge status={testState} /> : null}
        </div>
        {pluginId === 'codex-cli-chat' ? (
          <section className="space-y-4 border-t border-border pt-5" aria-labelledby="wechat-heading">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 id="wechat-heading" className="flex items-center gap-2 text-sm font-medium"><Puzzle className="size-4 text-muted-foreground" aria-hidden="true" />{tPlugins('wechat.title')}</h2>
                <p className="mt-1 text-[13px] text-muted-foreground">{tPlugins('wechat.description')}</p>
              </div>
              <StatusBadge status={plugin.wechat.status} />
            </div>
            {plugin.wechat.qrCode ? <div className="space-y-2">{wechatQrImage ? <img src={wechatQrImage} alt={tPlugins('wechat.qrAlt')} className="size-48 rounded border border-border bg-white object-contain p-2" /> : <a href={plugin.wechat.qrCode} target="_blank" rel="noreferrer" className="text-sm text-brand underline underline-offset-4">{tPlugins('wechat.openQrLink')}</a>}<p className="text-[13px] text-muted-foreground">{tPlugins('wechat.scan')}</p></div> : null}
            <dl className="grid gap-3 text-[13px] sm:grid-cols-2"><div><dt className="text-muted-foreground">{tPlugins('wechat.botId')}</dt><dd className="font-mono">{plugin.wechat.botId || tPlugins('wechat.notConnected')}</dd></div><div><dt className="text-muted-foreground">{tPlugins('wechat.conversations')}</dt><dd className="tabular-nums">{plugin.wechat.conversationCount}</dd></div></dl>
            {plugin.wechat.lastError ? <p className="text-[13px] text-danger" role="alert">{plugin.wechat.lastError}</p> : null}
            <div className="flex flex-wrap gap-3"><Button type="button" variant="secondary" onClick={() => void startWechatLogin()} disabled={wechatPending || plugin.wechat.status === 'connected'}>{wechatPending ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : plugin.wechat.status === 'qr_pending' ? <RefreshCw aria-hidden="true" /> : <LogIn aria-hidden="true" />}{plugin.wechat.status === 'qr_pending' ? tPlugins('wechat.refresh') : tPlugins('wechat.login')}</Button>{plugin.wechat.status !== 'disconnected' ? <Button type="button" variant="ghost" onClick={() => void disconnectWechat()} disabled={wechatPending}><Unplug aria-hidden="true" />{tPlugins('wechat.disconnect')}</Button> : null}</div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
