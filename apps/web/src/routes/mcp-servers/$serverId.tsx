import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { LoaderCircle, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ErrorState } from '@/components/error-state';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { PasswordInput } from '@/components/password-input';
import { SaveIndicator } from '@/components/save-indicator';
import { StatusBadge } from '@/components/status-badge';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { McpServerDeleteDialog } from '@/features/mcp-servers/delete-dialog';
import { api } from '@/api/client';
import { useMcpServerQuery } from '@/api/queries';
import { queryClient } from '@/lib/query-client';
import type { McpServerView } from '@worklite/contracts';

export const Route = createFileRoute('/mcp-servers/$serverId')({
  component: McpConfigPage,
});

function McpConfigPage() {
  const { t } = useTranslation(['mcpServers', 'common']);
  const { serverId } = Route.useParams();
  const workspaceSlug = 'personal';
  const isNew = serverId === 'new';
  const { data: server, isLoading: serverLoading, isError: serverError, refetch: refetchServer } = useMcpServerQuery(workspaceSlug, serverId);
  const editorLoading = !isNew && serverLoading;
  const navigate = useNavigate();
  const [testState, setTestState] = useState<'idle' | 'pending' | 'success' | 'auth_failed' | 'unreachable'>(
    server?.connection === 'connected' ? 'success' : server?.connection === 'auth_failed' ? 'auth_failed' : 'idle',
  );
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>(isNew ? 'unsaved' : 'saved');
  const [allowed, setAllowed] = useState<string[]>([]);
  const [discoveredTools, setDiscoveredTools] = useState<Array<{ name: string; description?: string }>>([]);
  const [toolsRestored, setToolsRestored] = useState(false);
  const [testError, setTestError] = useState('');
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (!server) return;
    setName(server.name);
    setEndpoint(server.endpoint);
    setAllowed(server.allowedToolNames);
    // The persisted allowed set must stay visible so it remains deselectable, but it
    // is a restored selection rather than a fresh discovery and is labelled as such.
    setDiscoveredTools(server.allowedToolNames.map((tool) => ({ name: tool })));
    setToolsRestored(server.allowedToolNames.length > 0);
    setTestState(server.connection === 'connected' ? 'success' : server.connection === 'auth_failed' ? 'auth_failed' : 'idle');
    setSaveState('saved');
    setSaveError('');
  }, [server]);

  // Saving a connection necessarily connects, so the handshake runs inside Save
  // rather than behind a second control. Persistence and handshake failures are
  // reported separately: the draft is stored even when the server cannot be reached.
  async function save(): Promise<McpServerView | null> {
    if (saving || !name.trim() || !endpoint.trim()) return null;
    setSaving(true);
    setSaveError('');
    setTestError('');
    setSaveState('saving');
    setTestState('pending');
    let saved: McpServerView;
    try {
      saved = isNew
        ? await api.createMcpServer(workspaceSlug, { name: name.trim(), endpoint: endpoint.trim(), authToken: token || undefined, allowedTools: allowed })
        : await api.updateMcpServer(workspaceSlug, serverId, { name: name.trim(), endpoint: endpoint.trim(), ...(token ? { authToken: token } : {}), allowedTools: allowed });
      queryClient.setQueryData(['mcp-server', saved.id], saved);
      setSaveState('saved');
      toast.success(t('config.saved'));
      if (isNew) void navigate({ to: '/mcp-servers/$serverId', params: { serverId: saved.id }, replace: true });
      void queryClient.invalidateQueries({ queryKey: ['mcp-servers'] }).catch(() => undefined);
    } catch (error: unknown) {
      setSaveState('unsaved');
      setTestState('idle');
      setSaveError(error instanceof Error ? error.message : t('config.saveFailed'));
      setSaving(false);
      return null;
    }

    try {
      const result = await api.testMcpServer(workspaceSlug, saved.id);
      setTestState(result.connection === 'connected' ? 'success' : result.connection);
      setTestError(result.error ? t(`config.testErrors.${result.error}`) : '');
      if (result.connection === 'connected') {
        setDiscoveredTools(result.tools);
        setToolsRestored(false);
        setAllowed((current) => current.filter((tool) => result.tools.some((candidate) => candidate.name === tool)));
      }
      queryClient.setQueryData(['mcp-server', saved.id], { ...saved, connection: result.connection });
      void queryClient.invalidateQueries({ queryKey: ['mcp-servers'] }).catch(() => undefined);
    } catch (error: unknown) {
      setTestState('unreachable');
      setTestError(error instanceof Error ? error.message : t('config.testErrors.unreachable'));
    } finally {
      setSaving(false);
    }
    return saved;
  }

  if (editorLoading) {
    return (
      <div className="mx-auto w-full max-w-[840px] px-4 py-6 md:px-6 md:py-8">
          <WorkspaceChrome crumbs={[{ label: t('title'), to: '/mcp-servers' }]} />
        <div className="flex flex-col gap-4" role="status" aria-busy="true" aria-live="polite">
          <span className="sr-only">{t('config.loading')}</span>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-full max-w-lg" />
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  if (!isNew && serverError) {
    return (
      <div className="mx-auto w-full max-w-[840px] px-4 py-6 md:px-6 md:py-8">
        <WorkspaceChrome crumbs={[{ label: t('title'), to: '/mcp-servers' }]} />
        <ErrorState title={t('config.fallback')} description={t('config.loadFailed')} onAction={() => void refetchServer()} />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[840px] px-4 py-6 md:px-6 md:py-8">
      <WorkspaceChrome
        crumbs={[
          { label: t('title'), to: '/mcp-servers' },
          { label: isNew ? t('config.new') : server?.name ?? t('config.fallback') },
        ]}
        status={<SaveIndicator state={saveState} />}
        actions={
          <div className="flex items-center gap-2">
            {!isNew ? <Button type="button" variant="ghost" size="icon-compact" aria-label={t('delete.action', { name: server?.name ?? name })} title={t('delete.action', { name: server?.name ?? name })} onClick={() => setDeleteOpen(true)}><Trash2 className="size-4" /></Button> : null}
            <Button size="compact" onClick={() => void save()} disabled={saving || !name.trim() || !endpoint.trim()}>{saving ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}{t('common:actions.save')}</Button>
          </div>
        }
      />
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{isNew ? t('config.title') : server?.name}</h1>
        <p className="text-[13px] text-muted-foreground">{t('config.description')}</p>
        {saveError ? <p className="text-[13px] text-danger" role="alert">{saveError}</p> : null}
        <Field label={t('config.name')} htmlFor="name">
          <Input id="name" value={name} onChange={(event) => { setName(event.target.value); setSaveState('unsaved'); }} />
        </Field>
        <Field label={t('config.endpoint')} htmlFor="endpoint">
          <Input id="endpoint" placeholder="https://mcp.example.com/mcp" value={endpoint} onChange={(event) => { setEndpoint(event.target.value); setSaveState('unsaved'); }} />
        </Field>
        <Field label={t('config.authentication')} htmlFor="token">
          <PasswordInput id="token" placeholder={t('config.tokenPlaceholder')} autoComplete="off" value={token} onChange={(event) => { setToken(event.target.value); setSaveState('unsaved'); }} />
        </Field>
        {testState === 'idle' ? null : (
          <div className="flex items-center gap-3">
            {testState === 'pending' ? (
              <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground" role="status">
                <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                {t('config.connecting')}
              </span>
            ) : (
              <StatusBadge status={testState === 'success' ? 'connected' : testState} />
            )}
          </div>
        )}
        {testError ? <p className="text-[13px] text-danger" role="alert">{testError}</p> : null}
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium">{t('config.allowedTools')}</legend>
          {toolsRestored && discoveredTools.length > 0 ? <p className="text-[13px] text-muted-foreground">{t('config.toolsRestored')}</p> : null}
          {discoveredTools.length === 0 ? <p className="text-[13px] text-muted-foreground">{testState === 'success' ? t('config.noToolsExposed') : t('config.noTools')}</p> : discoveredTools.map((tool) => (
            <label key={tool.name} className="flex items-start gap-2 text-[13px]">
              <Checkbox
                className="mt-0.5"
                checked={allowed.includes(tool.name)}
                onCheckedChange={(checked) => {
                  setAllowed((current) => (checked ? [...current, tool.name] : current.filter((item) => item !== tool.name)));
                  setSaveState('unsaved');
                }}
              />
              <span className="min-w-0"><span className="block font-mono">{tool.name}</span>{tool.description ? <span className="mt-0.5 block text-xs text-muted-foreground">{tool.description}</span> : null}</span>
            </label>
          ))}
        </fieldset>
      </div>
      <McpServerDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        serverId={serverId}
        name={server?.name ?? name}
        onDeleted={() => void navigate({ to: '/mcp-servers' })}
      />
    </div>
  );
}
