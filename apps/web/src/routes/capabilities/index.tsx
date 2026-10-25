import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Blocks, FolderUp, Plus, Puzzle, RefreshCw, Server, Settings2, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { LocalSkillSyncResult, McpServerView, PluginView, SkillView } from '@worklite/contracts';
import { api } from '@/api/client';
import {
  skillsQueryKey,
  useMcpServersQuery,
  usePluginsQuery,
  useSkillsQuery,
} from '@/api/queries';
import { CollectionLoading } from '@/components/collection-loading';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { useLocale } from '@/components/locale-provider';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { McpServerDeleteDialog } from '@/features/mcp-servers/delete-dialog';
import { formatDateTime } from '@/i18n/format';

export const Route = createFileRoute('/capabilities/')({
  component: CapabilitiesPage,
});

type CapabilityResource =
  | { type: 'plugin'; value: PluginView }
  | { type: 'mcp'; value: McpServerView }
  | { type: 'skill'; value: SkillView };

function CapabilitiesPage() {
  const { t: tWorkspace } = useTranslation('workspace');
  const { t: tPlugins } = useTranslation('plugins');
  const { t: tMcpServers } = useTranslation('mcpServers');
  const { t: tSkills } = useTranslation('skills');
  const { t: tCommon } = useTranslation('common');
  const { locale } = useLocale();
  const workspaceSlug = 'personal';
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const folderInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [mcpDeleteTarget, setMcpDeleteTarget] = useState<McpServerView | null>(null);
  const [skillDeleteTarget, setSkillDeleteTarget] = useState<SkillView | null>(null);
  const [skillDeleteBusy, setSkillDeleteBusy] = useState(false);
  const [skillDeleteError, setSkillDeleteError] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [syncReport, setSyncReport] = useState<LocalSkillSyncResult | null>(null);
  const pluginsQuery = usePluginsQuery();
  const mcpServersQuery = useMcpServersQuery(workspaceSlug);
  const skillsQuery = useSkillsQuery(workspaceSlug);
  const plugins = pluginsQuery.data ?? [];
  const mcpServers = mcpServersQuery.data ?? [];
  const skills = skillsQuery.data ?? [];

  const syncLocalSkills = useMutation({
    mutationFn: () => api.syncLocalSkills(workspaceSlug),
    onMutate: () => setSyncReport(null),
    onSuccess: async (result) => {
      setSyncReport(result);
      await queryClient.invalidateQueries({ queryKey: skillsQueryKey(workspaceSlug) });
      if (!result.available) toast.error(result.unavailableReason ?? tSkills('localSync.failed'));
      else toast.success(tSkills('localSync.success', { created: result.created, updated: result.updated, unchanged: result.unchanged }));
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : tSkills('localSync.failed')),
  });
  const importSkill = useMutation({
    mutationFn: (input: { name: string; files: Array<{ path: string; content: string }> }) => api.importSkill(workspaceSlug, input),
    onSuccess: async (skill) => {
      await queryClient.invalidateQueries({ queryKey: skillsQueryKey(workspaceSlug) });
      void navigate({ to: '/capabilities/skills/$skillId', params: { skillId: skill.id } });
    },
    onError: () => setImportError(tSkills('import.failed')),
  });

  const visiblePlugins = plugins.filter((plugin) => plugin.id !== 'feishu-bot' && plugin.id !== 'wechat-bot');
  const visibleSkills = skills.filter((skill) => skill.id !== 'sk_worklite_platform');
  const resources = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const candidates: CapabilityResource[] = [
      ...visiblePlugins.map((value) => ({ type: 'plugin' as const, value })),
      ...mcpServers.map((value) => ({ type: 'mcp' as const, value })),
      ...visibleSkills.map((value) => ({ type: 'skill' as const, value })),
    ];
    return candidates
      .filter((resource) => {
        if (!normalizedSearch) return true;
        const value = resource.value;
        const searchText = resource.type === 'plugin'
          ? `${value.name} ${value.description} ${value.command}`
          : resource.type === 'mcp'
            ? `${value.name} ${value.transport} ${value.version} ${value.allowedToolNames.join(' ')}`
            : `${value.name} ${value.description ?? ''} ${value.source} ${value.version}`;
        return searchText.toLowerCase().includes(normalizedSearch);
      })
      .sort((left, right) => left.value.name.localeCompare(right.value.name));
  }, [plugins, mcpServers, search, skills]);
  const hasResources = visiblePlugins.length > 0 || mcpServers.length > 0 || visibleSkills.length > 0;
  const isLoading = pluginsQuery.isLoading || mcpServersQuery.isLoading || skillsQuery.isLoading;
  const isError = pluginsQuery.isError || mcpServersQuery.isError || skillsQuery.isError;

  async function handleFolderChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (selected.length === 0) return;
    setImportError(null);
    try {
      const relativePaths = selected.map((file) => file.webkitRelativePath || file.name);
      const root = relativePaths[0]?.split('/')[0] ?? '';
      const files = await Promise.all(selected.map(async (file, index) => ({
        path: stripRoot(relativePaths[index] ?? file.name, root),
        content: await file.text(),
      })));
      if (!files.some((file) => file.path === 'SKILL.md')) {
        setImportError(tSkills('import.missingSkillFile'));
        return;
      }
      importSkill.mutate({ name: root || tSkills('import.defaultName'), files });
    } catch {
      setImportError(tSkills('import.readFailed'));
    }
  }

  async function deleteSkill() {
    if (!skillDeleteTarget || skillDeleteBusy) return;
    setSkillDeleteBusy(true);
    setSkillDeleteError('');
    try {
      await api.deleteSkill(workspaceSlug, skillDeleteTarget.id);
      setSkillDeleteTarget(null);
      toast.success(tSkills('delete.success'));
      await queryClient.invalidateQueries({ queryKey: skillsQueryKey() });
    } catch (error) {
      setSkillDeleteError(error instanceof Error ? error.message : tSkills('delete.failed'));
    } finally {
      setSkillDeleteBusy(false);
    }
  }

  function getTypeLabel(type: CapabilityResource['type']) {
    if (type === 'plugin') return tWorkspace('nav.plugins');
    if (type === 'mcp') return tWorkspace('nav.mcpServers');
    return tWorkspace('nav.skills');
  }

  function renderResourceRow(resource: CapabilityResource) {
    const nameLink = resource.type === 'plugin'
      ? <Link to="/capabilities/plugins/$pluginId" params={{ pluginId: resource.value.id }} className="truncate text-sm font-medium hover:underline">{resource.value.name}</Link>
      : resource.type === 'mcp'
        ? <Link to="/capabilities/mcp-servers/$serverId" params={{ serverId: resource.value.id }} className="truncate text-sm font-medium hover:underline">{resource.value.name}</Link>
        : <Link to="/capabilities/skills/$skillId" params={{ skillId: resource.value.id }} className="truncate text-sm font-medium hover:underline">{resource.value.name}</Link>;
    const icon = resource.type === 'plugin' ? Puzzle : resource.type === 'mcp' ? Server : Blocks;
    const Icon = icon;
    const subtitle = resource.type === 'plugin'
      ? resource.value.description
      : resource.type === 'mcp'
        ? resource.value.transport
        : resource.value.description;

    return (
      <CollectionRow key={`${resource.type}-${resource.value.id}`} className="min-w-[820px] whitespace-nowrap grid-cols-[minmax(0,2fr)_110px_minmax(0,2fr)_150px_40px]">
        <span className="flex min-w-0 items-center gap-3">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate">{nameLink}</span>
            {subtitle ? <span className="block truncate text-[13px] text-muted-foreground">{subtitle}</span> : null}
          </span>
        </span>
        <Badge variant="neutral" className="w-fit">{getTypeLabel(resource.type)}</Badge>
        <span className="flex min-w-0 items-center gap-3 text-[13px] text-muted-foreground">
          {resource.type === 'plugin' ? (
            <>
              <code className="truncate">{resource.value.command}</code>
              <StatusBadge status={resource.value.status} />
            </>
          ) : resource.type === 'mcp' ? (
            <>
              <span className="truncate">{tMcpServers('columns.allowedTools')}: {resource.value.allowedTools} · {resource.value.version}</span>
              <StatusBadge status={resource.value.connection} />
            </>
          ) : (
            <span className="truncate">{tSkills(`source.${resource.value.source}`)} · {resource.value.version}</span>
          )}
        </span>
        <span className="tabular-nums text-[13px] text-muted-foreground">{formatDateTime(resource.value.updatedAt, locale)}</span>
        <span className="flex items-center justify-end">
          {resource.type === 'plugin' ? (
            <Button asChild variant="ghost" size="icon-compact">
              <Link to="/capabilities/plugins/$pluginId" params={{ pluginId: resource.value.id }} aria-label={tWorkspace('capabilityResources.configure', { name: resource.value.name })} title={tWorkspace('capabilityResources.configure', { name: resource.value.name })}>
                <Settings2 className="size-4" />
              </Link>
            </Button>
          ) : resource.type === 'mcp' ? (
            <Button type="button" variant="ghost" size="icon-compact" className="text-danger hover:text-danger" aria-label={tMcpServers('delete.action', { name: resource.value.name })} onClick={() => setMcpDeleteTarget(resource.value)}>
              <Trash2 className="size-4" />
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="icon-compact" className="text-danger hover:text-danger" aria-label={tSkills('delete.action', { name: resource.value.name })} onClick={() => { setSkillDeleteError(''); setSkillDeleteTarget(resource.value); }}>
              <Trash2 className="size-4" />
            </Button>
          )}
        </span>
      </CollectionRow>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
      <WorkspaceChrome crumbs={[{ label: tWorkspace('nav.capabilities') }]} />
      <PageHeading title={tWorkspace('nav.capabilities')} />
      <CollectionToolbar
        className="mt-6"
        search={search}
        onSearchChange={setSearch}
        placeholder={tWorkspace('capabilityResources.search')}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => syncLocalSkills.mutate()} disabled={syncLocalSkills.isPending}>
              <RefreshCw className={syncLocalSkills.isPending ? 'size-4 motion-safe:animate-spin' : 'size-4'} />
              {syncLocalSkills.isPending ? tSkills('localSync.syncing') : tSkills('localSync.action')}
            </Button>
            <input ref={folderInput} type="file" multiple className="sr-only" onChange={(event) => void handleFolderChange(event)} {...({ webkitdirectory: '' } as Record<string, string>)} />
            <Button type="button" variant="secondary" onClick={() => folderInput.current?.click()} disabled={importSkill.isPending}>
              <FolderUp className="size-4" />
              {importSkill.isPending ? tSkills('import.importing') : tSkills('import.action')}
            </Button>
            <Button asChild variant="secondary">
              <Link to="/capabilities/mcp-servers/$serverId" params={{ serverId: 'new' }}>
                <Plus className="size-4" />
                {tMcpServers('create')}
              </Link>
            </Button>
            <Button asChild>
              <Link to="/capabilities/skills/$skillId" params={{ skillId: 'new' }}>
                <Plus className="size-4" />
                {tSkills('create')}
              </Link>
            </Button>
          </div>
        }
      />
      {importError ? <p role="alert" className="mt-3 text-sm text-danger">{importError}</p> : null}
      {syncReport && (!syncReport.available || syncReport.skipped.length > 0 || syncReport.removed.length > 0) ? (
        <div className="mt-3 rounded-md border border-border bg-surface-subtle px-3 py-2 text-[13px]">
          <p className="text-muted-foreground">{tSkills('localSync.root', { root: syncReport.root })}</p>
          {!syncReport.available ? <p role="alert" className="mt-1 text-danger">{syncReport.unavailableReason}</p> : null}
          {syncReport.skipped.length > 0 ? (
            <>
              <p className="mt-2 font-medium">{tSkills('localSync.skipped')}</p>
              <ul className="mt-1 space-y-1 text-muted-foreground">
                {syncReport.skipped.map((item) => <li key={item.directory}><span className="font-mono">{item.directory}</span>: {item.reason}</li>)}
              </ul>
            </>
          ) : null}
          {syncReport.removed.length > 0 ? <p className="mt-2 text-muted-foreground">{tSkills('localSync.removed', { count: syncReport.removed.length })}</p> : null}
        </div>
      ) : null}
      <div className="mt-4">
        {isLoading ? (
          <CollectionLoading
            label={tWorkspace('capabilityResources.loading')}
            columns={[tWorkspace('capabilityResources.columns.resource'), tWorkspace('capabilityResources.columns.type'), tWorkspace('capabilityResources.columns.details'), tWorkspace('capabilityResources.columns.updated'), tWorkspace('capabilityResources.columns.actions')]}
            headerClassName="min-w-[820px] grid-cols-[minmax(0,2fr)_110px_minmax(0,2fr)_150px_40px]"
            rowClassName="min-w-[820px] whitespace-nowrap grid-cols-[minmax(0,2fr)_110px_minmax(0,2fr)_150px_40px]"
          />
        ) : isError ? (
          <ErrorState
            title={tWorkspace('nav.capabilities')}
            description={tWorkspace('capabilityResources.loadFailed')}
            onAction={() => { void Promise.all([pluginsQuery.refetch(), mcpServersQuery.refetch(), skillsQuery.refetch()]); }}
          />
        ) : !hasResources ? (
          <EmptyState title={tWorkspace('capabilityResources.empty.title')} description={tWorkspace('capabilityResources.empty.description')} />
        ) : resources.length === 0 ? (
          <EmptyState
            title={tWorkspace('capabilityResources.noMatches.title')}
            description={tWorkspace('capabilityResources.noMatches.description', { search })}
            actionLabel={tCommon('actions.clearFilters')}
            onAction={() => setSearch('')}
          />
        ) : (
          <CollectionTable>
            <CollectionHeader
              className="min-w-[820px] grid-cols-[minmax(0,2fr)_110px_minmax(0,2fr)_150px_40px]"
              columns={[tWorkspace('capabilityResources.columns.resource'), tWorkspace('capabilityResources.columns.type'), tWorkspace('capabilityResources.columns.details'), tWorkspace('capabilityResources.columns.updated'), tWorkspace('capabilityResources.columns.actions')]}
            />
            {resources.map(renderResourceRow)}
          </CollectionTable>
        )}
      </div>
      <McpServerDeleteDialog
        open={mcpDeleteTarget !== null}
        onOpenChange={(nextOpen) => { if (!nextOpen) setMcpDeleteTarget(null); }}
        serverId={mcpDeleteTarget?.id ?? ''}
        name={mcpDeleteTarget?.name ?? ''}
        onDeleted={() => setMcpDeleteTarget(null)}
      />
      <ConfirmDialog
        open={skillDeleteTarget !== null}
        onOpenChange={(nextOpen) => { if (!nextOpen && !skillDeleteBusy) setSkillDeleteTarget(null); }}
        title={tSkills('delete.title', { name: skillDeleteTarget?.name ?? '' })}
        description={tSkills('delete.description')}
        confirmLabel={tCommon('actions.delete')}
        cancelLabel={tCommon('actions.cancel')}
        busyLabel={tSkills('delete.deleting')}
        error={skillDeleteError}
        busy={skillDeleteBusy}
        onConfirm={() => void deleteSkill()}
      />
    </div>
  );
}

function stripRoot(path: string, root: string): string {
  const prefix = root ? `${root}/` : '';
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
