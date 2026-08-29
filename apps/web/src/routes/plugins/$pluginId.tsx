import { createFileRoute, Link } from '@tanstack/react-router';
import { LoaderCircle, Puzzle, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
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
  useEffect(() => {
    if (!plugin) return;
    setCommand(plugin.command);
    setTestState(plugin.status);
    setSaveState('saved');
    setError('');
  }, [plugin]);

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
      </div>
    </div>
  );
}
