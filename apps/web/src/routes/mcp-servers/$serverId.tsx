import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/password-input';
import { SaveIndicator } from '@/components/save-indicator';
import { StatusBadge } from '@/components/status-badge';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { api } from '@/api/client';
import { useMcpServerQuery } from '@/api/queries';

export const Route = createFileRoute('/mcp-servers/$serverId')({
  component: McpConfigPage,
});

const DISCOVERED_TOOLS = ['search_docs', 'get_page', 'list_spaces', 'create_comment'];

function McpConfigPage() {
  const { t } = useTranslation(['mcpServers', 'common']);
  const { serverId } = Route.useParams();
  const workspaceSlug = "personal";
  const isNew = serverId === 'new';
  const { data: server } = useMcpServerQuery(workspaceSlug, serverId);
  const [testState, setTestState] = useState<'idle' | 'pending' | 'success' | 'auth_failed' | 'unreachable'>(
    server?.connection === 'connected' ? 'success' : server?.connection === 'auth_failed' ? 'auth_failed' : 'idle',
  );
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>(isNew ? 'unsaved' : 'saved');
  const [allowed, setAllowed] = useState<string[]>(DISCOVERED_TOOLS.slice(0, 2));
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');

  useEffect(() => {
    if (!server) return;
    setName(server.name);
    setTestState(server.connection === 'connected' ? 'success' : server.connection === 'auth_failed' ? 'auth_failed' : 'idle');
    setSaveState('saved');
  }, [server]);

  return (
    <div className="mx-auto w-full max-w-[840px] px-6 py-6">
      <WorkspaceChrome
        crumbs={[
          { label: t('title'), to: '/mcp-servers' },
          { label: isNew ? t('config.new') : server?.name ?? t('config.fallback') },
        ]}
        status={<SaveIndicator state={saveState} />}
        actions={
          <Button size="compact" onClick={() => void (isNew ? api.createMcpServer(workspaceSlug, { name, endpoint, authToken: token }) : Promise.resolve(server)).then(() => toast.success(t('config.published')))}>
            {t('common:actions.publish')}
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{isNew ? t('config.title') : server?.name}</h1>
        <p className="text-[13px] text-muted-foreground">{t('config.description')}</p>
        <Field label={t('config.name')} htmlFor="name">
          <Input id="name" value={name} onChange={(event) => { setName(event.target.value); setSaveState('unsaved'); }} />
        </Field>
        <Field label={t('config.endpoint')} htmlFor="endpoint">
          <Input id="endpoint" placeholder="https://mcp.example.com/mcp" value={endpoint} onChange={(event) => { setEndpoint(event.target.value); setSaveState('unsaved'); }} />
        </Field>
        <Field label={t('config.authentication')} htmlFor="token">
          <PasswordInput id="token" placeholder={t('config.tokenPlaceholder')} autoComplete="off" value={token} onChange={(event) => { setToken(event.target.value); setSaveState('unsaved'); }} />
        </Field>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setTestState('pending');
              window.setTimeout(() => setTestState(server?.connection === 'auth_failed' ? 'auth_failed' : 'success'), 500);
            }}
          >
            {testState === 'pending' ? t('config.testing') : t('config.test')}
          </Button>
          {testState === 'success' ? <StatusBadge status="connected" /> : null}
          {testState === 'auth_failed' ? <StatusBadge status="auth_failed" /> : null}
          {testState === 'unreachable' ? <StatusBadge status="unreachable" /> : null}
        </div>
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium">{t('config.allowedTools')}</legend>
          {DISCOVERED_TOOLS.map((tool) => (
            <label key={tool} className="flex items-center gap-2 text-[13px]">
              <Checkbox
                checked={allowed.includes(tool)}
                onCheckedChange={(checked) => {
                  setAllowed((current) => (checked ? [...current, tool] : current.filter((item) => item !== tool)));
                  setSaveState('unsaved');
                }}
              />
              <span className="font-mono">{tool}</span>
            </label>
          ))}
        </fieldset>
        <p className="text-[13px] text-muted-foreground">{t('config.publishHint')}</p>
      </div>
    </div>
  );
}
