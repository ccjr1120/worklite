import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Blocks, FolderUp, Settings2, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { WORKLITE_PLATFORM_SKILL_NAME, type SkillView } from '@worklite/contracts';
import { api } from '@/api/client';
import { skillsQueryKey, useSkillsQuery } from '@/api/queries';
import { CollectionLoading } from '@/components/collection-loading';
import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { CollectionToolbar } from '@/components/collection-toolbar';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { useLocale } from '@/components/locale-provider';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { formatDateTime } from '@/i18n/format';

export const Route = createFileRoute('/skills/')({
  component: SkillListPage,
});

const tableClassName = 'min-w-[860px] md:grid-cols-[minmax(200px,1fr)_minmax(120px,1fr)_90px_110px_150px_minmax(80px,max-content)]';

function SkillListPage() {
  const { t } = useTranslation(['skills', 'common']);
  const { locale } = useLocale();
  const workspaceSlug = 'personal';
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const folderInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const { data: all = [], isLoading, isError, refetch } = useSkillsQuery(workspaceSlug);
  const visibleSkills = useMemo(
    () => all.filter((skill) => skill.root !== 'platform' || skill.directory !== WORKLITE_PLATFORM_SKILL_NAME),
    [all],
  );
  const items = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return visibleSkills
      .filter((skill) => !normalizedSearch || `${skill.name} ${skill.description ?? ''} ${skill.root} ${skill.directory} ${skill.version} ${skill.validation} ${skill.validationReason ?? ''} ${skill.conflict?.reason ?? ''}`.toLowerCase().includes(normalizedSearch))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [search, visibleSkills]);

  const importSkill = useMutation({
    mutationFn: (input: { name: string; files: Array<{ path: string; content: string }> }) => api.importSkill(workspaceSlug, input),
    onSuccess: async (skill) => {
      await queryClient.invalidateQueries({ queryKey: skillsQueryKey(workspaceSlug) });
      void navigate({ to: '/skills/$skillId', params: { skillId: skill.id } });
    },
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
      const files = await Promise.all(selected.map(async (file, index) => ({
        path: stripRoot(relativePaths[index] ?? file.name, root),
        content: await file.text(),
      })));
      if (!files.some((file) => file.path === 'SKILL.md')) {
        setImportError(t('import.missingSkillFile'));
        return;
      }
      importSkill.mutate({ name: root || t('import.defaultName'), files });
    } catch {
      setImportError(t('import.readFailed'));
    }
  }

  async function deleteSkill() {
    if (!deleteTarget || deleteBusy) return;
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
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
      <WorkspaceChrome crumbs={[{ label: t('title') }]} />
      <PageHeading title={t('title')} />
      <CollectionToolbar
        className="mt-6"
        search={search}
        onSearchChange={setSearch}
        placeholder={t('search')}
        actions={
          <>
            <input ref={folderInput} type="file" multiple className="sr-only" onChange={(event) => void handleFolderChange(event)} {...({ webkitdirectory: '' } as Record<string, string>)} />
            <Button type="button" onClick={() => folderInput.current?.click()} disabled={importSkill.isPending}>
              <FolderUp className="size-4" aria-hidden="true" />
              {importSkill.isPending ? t('import.importing') : t('import.action')}
            </Button>
          </>
        }
      />
      {importError ? <p role="alert" className="mt-3 text-sm text-danger">{importError}</p> : null}
      <div className="mt-4">
        {isLoading ? (
          <CollectionLoading
            label={t('loading')}
            columns={[t('columns.skill'), t('columns.root'), t('columns.version'), t('columns.validation'), t('columns.updated'), t('columns.actions')]}
            headerClassName={tableClassName}
            rowClassName={tableClassName}
          />
        ) : isError ? (
          <ErrorState title={t('title')} description={t('loadFailed')} onAction={() => void refetch()} />
        ) : visibleSkills.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : items.length === 0 ? (
          <EmptyState title={t('noMatches.title')} description={t('noMatches.description', { search })} actionLabel={t('common:actions.clearFilters')} onAction={() => setSearch('')} />
        ) : (
          <CollectionTable>
            <CollectionHeader className={tableClassName} columns={[t('columns.skill'), t('columns.root'), t('columns.version'), t('columns.validation'), t('columns.updated'), t('columns.actions')]} />
            {items.map((skill) => (
              <CollectionRow key={skill.id} className={tableClassName}>
                <Link to="/skills/$skillId" params={{ skillId: skill.id }} className="flex min-w-0 items-center gap-3">
                  <Blocks className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="block min-w-0 flex-1 truncate text-sm font-medium" title={skill.name}>{skill.name}</span>
                      {skill.conflict ? <Badge variant="warning" title={`${skill.conflict.reason} ${skill.conflict.ignoredPath}`}>{t('conflict.title')}</Badge> : null}
                      {skill.validation === 'invalid' && skill.validationReason ? <Badge variant="warning" title={skill.validationReason}>{t('invalid.title')}</Badge> : null}
                    </span>
                    {skill.description ? <span className="block truncate text-[13px] text-muted-foreground" title={skill.description}>{skill.description}</span> : null}
                  </span>
                </Link>
                <span className="min-w-0 truncate text-[13px] text-muted-foreground" title={skill.rootPath}>{skill.rootPath}</span>
                <span className="font-mono text-[13px]">{skill.version}</span>
                <StatusBadge status={skill.validation} />
                <span className="tabular-nums text-[13px] text-muted-foreground">{formatDateTime(skill.updatedAt, locale)}</span>
                <span className="flex flex-nowrap items-center justify-end gap-1 whitespace-nowrap">
                  <Button asChild variant="ghost" size="icon-compact" data-row-action>
                    <Link to="/skills/$skillId" params={{ skillId: skill.id }} aria-label={t('common:actions.open')} title={t('common:actions.open')}>
                      <Settings2 className="size-4" />
                    </Link>
                  </Button>
                  <Button type="button" variant="ghost" size="icon-compact" className="text-danger hover:text-danger" data-row-action aria-label={t('delete.action', { name: skill.name })} title={t('delete.action', { name: skill.name })} onClick={() => { setDeleteError(''); setDeleteTarget(skill); }}>
                    <Trash2 className="size-4" />
                  </Button>
                </span>
              </CollectionRow>
            ))}
          </CollectionTable>
        )}
      </div>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => { if (!nextOpen && !deleteBusy) setDeleteTarget(null); }}
        title={t('delete.title', { name: deleteTarget?.name ?? '' })}
        description={t('delete.description', { root: deleteTarget?.rootPath ?? '', directory: deleteTarget?.directory ?? '' })}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        busyLabel={t('delete.deleting')}
        error={deleteError}
        busy={deleteBusy}
        onConfirm={() => void deleteSkill()}
      />
    </div>
  );
}

function stripRoot(path: string, root: string): string {
  const prefix = root ? `${root}/` : '';
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
