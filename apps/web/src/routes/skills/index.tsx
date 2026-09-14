import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { FolderUp, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { AgentResourceNav } from '@/components/agent-resource-nav';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeading } from '@/components/page-heading';
import { Button } from '@/components/ui/button';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { skillsQueryKey, useSkillsQuery } from '@/api/queries';
import { api } from '@/api/client';

export const Route = createFileRoute('/skills/')({
  component: SkillListPage,
});

function SkillListPage() {
  const { t } = useTranslation(['skills', 'common']);
  const { locale } = useLocale();
  const workspaceSlug = 'personal';
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const folderInput = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<(typeof all)[number] | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const { data: all = [], isLoading, isError } = useSkillsQuery(workspaceSlug);
  const importSkill = useMutation({
    mutationFn: (input: { name: string; files: Array<{ path: string; content: string }> }) => api.importSkill(workspaceSlug, input),
    onSuccess: async (skill) => { await queryClient.invalidateQueries({ queryKey: skillsQueryKey(workspaceSlug) }); void navigate({ to: '/skills/$skillId', params: { skillId: skill.id } }); },
    onError: () => setImportError(t('import.failed')),
  });

  async function handleFolderChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (selected.length === 0) return;
    setImportError(null);
    try {
      const relativePaths = selected.map((file) => file.webkitRelativePath || file.name);
      const root = relativePaths[0]?.split('/')[0] ?? '';
      const files = await Promise.all(selected.map(async (file, index) => ({ path: stripRoot(relativePaths[index] ?? file.name, root), content: await file.text() })));
      if (!files.some((file) => file.path === 'SKILL.md')) { setImportError(t('import.missingSkillFile')); return; }
      importSkill.mutate({ name: root || t('import.defaultName'), files });
    } catch { setImportError(t('import.readFailed')); }
  }

  const items = useMemo(() => all.filter((item) => item.id !== 'sk_worklite_platform' && item.name.toLowerCase().includes(search.toLowerCase())), [all, search]);

  async function deleteResource() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await api.deleteSkill(workspaceSlug, deleteTarget.id);
      setDeleteTarget(null);
      toast.success(t('delete.success'));
      await queryClient.invalidateQueries({ queryKey: skillsQueryKey() });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t('delete.failed'));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
      <WorkspaceChrome
        crumbs={[{ label: t('title') }]}
      />
      <PageHeading title={t('title')} description={t('description')} />
      <AgentResourceNav active="skills" />
      <CollectionToolbar
        className="mt-6"
        search={search}
        onSearchChange={setSearch}
        placeholder={t('search')}
        actions={
          <div className="flex items-center gap-2">
            <input ref={folderInput} type="file" multiple className="sr-only" onChange={(event) => void handleFolderChange(event)} {...({ webkitdirectory: '' } as Record<string, string>)} />
            <Button type="button" variant="secondary" size="compact" onClick={() => folderInput.current?.click()} disabled={importSkill.isPending}>
              <FolderUp className="size-4" />
              {importSkill.isPending ? t('import.importing') : t('import.action')}
            </Button>
            <Button asChild size="compact">
            <Link to="/skills/$skillId" params={{ skillId: 'new' }}>
              <Plus className="size-4" />
              {t('create')}
            </Link>
            </Button>
          </div>
        }
      />
      {importError ? <p role="alert" className="mt-3 text-sm text-danger">{importError}</p> : null}
      <div className="mt-4">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading skills...</p> : isError ? <p className="text-sm text-danger">Unable to load skills.</p> : all.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : items.length === 0 ? (
          <EmptyState title={t('noMatches.title')} description={t('noMatches.description', { search })} actionLabel={t('common:actions.clearFilters')} onAction={() => setSearch('')} />
        ) : (
          <CollectionTable>
            <CollectionHeader className="min-w-[760px] grid-cols-[2fr_1fr_1fr_1fr_40px]" columns={[t('columns.skill'), t('columns.source'), t('columns.version'), t('columns.updated'), t('columns.actions')]} />
            {items.map((item) => (
              <CollectionRow key={item.id} className="min-w-[760px] whitespace-nowrap grid-cols-[2fr_1fr_1fr_1fr_40px]">
                <Link to="/skills/$skillId" params={{ skillId: item.id }} className="contents">
                  <span className="flex min-w-0 items-center gap-2 font-medium">
                    <span className="truncate">{item.name}</span>
                  </span>
                  <span className="text-[13px] text-muted-foreground">{t(`source.${item.source}`)}</span>
                  <span className="font-mono text-[13px]">{item.version}</span>
                  <span className="tabular-nums text-[13px] text-muted-foreground">{formatDateTime(item.updatedAt, locale)}</span>
                </Link>
                <Button type="button" variant="ghost" size="icon-compact" className="text-danger hover:text-danger" aria-label={t('delete.action', { name: item.name })} onClick={() => { setDeleteError(''); setDeleteTarget(item); }}><Trash2 className="size-4" /></Button>
              </CollectionRow>
            ))}
          </CollectionTable>
        )}
      </div>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => { if (!nextOpen && !deleteBusy) setDeleteTarget(null); }}
        title={t('delete.title', { name: deleteTarget?.name ?? '' })}
        description={t('delete.description')}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        busyLabel={t('delete.deleting')}
        error={deleteError}
        busy={deleteBusy}
        onConfirm={() => void deleteResource()}
      />
    </div>
  );
}

function stripRoot(path: string, root: string): string {
  const prefix = root ? `${root}/` : '';
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
