import { createFileRoute, Link } from '@tanstack/react-router';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, LayoutDashboard, LoaderCircle, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { HomeBoardCategoryView, RunView, WorkflowDashboardBinding, WorkflowDashboardElement, WorkflowDashboardField, WorkflowView } from '@worklite/contracts';
import { Button } from '@/components/ui/button';
import { focusRingInset, surfaceInteraction } from '@/components/ui/interaction';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import {
  useAgentQuery,
  useAssignHomeBoardMutation,
  useCreateHomeBoardCategoryMutation,
  useDeleteHomeBoardCategoryMutation,
  useHomeBoardPreferencesQuery,
  useModelProvidersQuery,
  useRenameHomeBoardCategoryMutation,
  useRunQuery,
  useRunsQuery,
  useWorkflowsQuery,
} from '@/api/queries';
import { useLocale } from '@/components/locale-provider';
import { CHAT_AGENT_ID } from '@worklite/contracts';
import { formatDateTime, formatNumber } from '@/i18n/format';
import type { AppLocale } from '@/i18n/locale';
import { cn } from '@/lib/utils';

type HomeBoard = {
  workflow: WorkflowView;
  dashboard: WorkflowDashboardBinding;
  run: RunView;
};

type HomeBoardGroup = {
  category: HomeBoardCategoryView | null;
  boards: HomeBoard[];
};

export const Route = createFileRoute('/home')({
  component: HomePage,
});

function HomePage() {
  const { t } = useTranslation(['home', 'workspace', 'common']);
  const workspaceKey = 'personal';
  const [newCategoryName, setNewCategoryName] = useState('');
  const [createCategoryOpen, setCreateCategoryOpen] = useState(false);
  const [renamingCategoryId, setRenamingCategoryId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingCategory, setDeletingCategory] = useState<HomeBoardCategoryView | null>(null);
  const [addingCategory, setAddingCategory] = useState<HomeBoardCategoryView | null>(null);
  const modelProvidersQuery = useModelProvidersQuery(workspaceKey);
  const chatQuery = useAgentQuery(workspaceKey, CHAT_AGENT_ID);
  const workflowsQuery = useWorkflowsQuery(workspaceKey);
  const runsQuery = useRunsQuery(workspaceKey);
  const categoriesQuery = useHomeBoardPreferencesQuery(workspaceKey);
  const createCategoryMutation = useCreateHomeBoardCategoryMutation(workspaceKey);
  const renameCategoryMutation = useRenameHomeBoardCategoryMutation(workspaceKey);
  const deleteCategoryMutation = useDeleteHomeBoardCategoryMutation(workspaceKey);
  const assignBoardMutation = useAssignHomeBoardMutation(workspaceKey);

  const boards = useMemo<HomeBoard[]>(() => {
    const workflows = workflowsQuery.data ?? [];
    const runs = runsQuery.data ?? [];

    return workflows.flatMap((workflow) => {
      if (!workflow.dashboard || !workflow.latestVersionId || workflow.latestVersion === null) return [];
      const expectedVersion = `v${workflow.latestVersion}`;
      const run = runs.find((item) => item.workflowId === workflow.id && item.version === expectedVersion && item.status === 'succeeded');
      return run ? [{ workflow, dashboard: workflow.dashboard, run }] : [];
    });
  }, [runsQuery.data, workflowsQuery.data]);

  const boardCategories = useMemo(() => new Map((categoriesQuery.data?.categories ?? []).flatMap((category) => category.workflowIds.map((workflowId) => [workflowId, category]))), [categoriesQuery.data]);
  const boardGroups = useMemo<HomeBoardGroup[]>(() => {
    const uncategorized = boards.filter((board) => !boardCategories.has(board.workflow.id));
    const groups: HomeBoardGroup[] = [];
    for (const category of categoriesQuery.data?.categories ?? []) {
      groups.push({ category, boards: boards.filter((board) => boardCategories.get(board.workflow.id)?.id === category.id) });
    }
    groups.push({ category: null, boards: uncategorized });
    return groups;
  }, [boards, boardCategories, categoriesQuery.data]);

  const firstUseStateReady = modelProvidersQuery.isSuccess && chatQuery.isSuccess;
  const providerConfigured = (modelProvidersQuery.data?.length ?? 0) > 0;
  const chatConfigured = providerConfigured && Boolean(chatQuery.data?.providerId && chatQuery.data.model);
  const libraryUnavailable = workflowsQuery.isError || runsQuery.isError || categoriesQuery.isError;
  const categoriesBusy = createCategoryMutation.isPending || renameCategoryMutation.isPending || deleteCategoryMutation.isPending || assignBoardMutation.isPending;
  const categoryError = categoriesQuery.isError || createCategoryMutation.isError || renameCategoryMutation.isError || deleteCategoryMutation.isError || assignBoardMutation.isError;

  function createCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newCategoryName.trim();
    if (!name || createCategoryMutation.isPending) return;
    createCategoryMutation.mutate({ name }, { onSuccess: () => { setNewCategoryName(''); setCreateCategoryOpen(false); } });
  }

  function renameCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = renameValue.trim();
    if (!renamingCategoryId || !name || renameCategoryMutation.isPending) return;
    renameCategoryMutation.mutate({ categoryId: renamingCategoryId, name }, { onSuccess: () => setRenamingCategoryId(null) });
  }

  async function deleteCategory() {
    if (!deletingCategory || deleteCategoryMutation.isPending) return;
    try {
      await deleteCategoryMutation.mutateAsync(deletingCategory.id);
      setDeletingCategory(null);
    } catch {
      // Keep the confirmation open so its local failure state remains available.
    }
  }

  function assignBoard(workflowId: string, categoryId: string | null) {
    assignBoardMutation.mutate({ workflowId, categoryId });
  }

  const deleteBusy = deleteCategoryMutation.isPending;

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <WorkspaceChrome crumbs={[{ label: t('workspace:nav.home') }]} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6 md:py-8">
          {firstUseStateReady && !chatConfigured ? <FirstUseGuide providerConfigured={providerConfigured} /> : null}

          <div className="mt-8">
            <PageHeading
              title={t('home:boards.title')}
              actions={(
                <Button type="button" variant="secondary" disabled={categoriesBusy} onClick={() => setCreateCategoryOpen(true)}>
                  <Plus className="size-4" />
                  {t('home:categories.create')}
                </Button>
              )}
            />

              {categoryError ? (
                <p className="mt-3 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2 text-[13px] text-danger" role="alert">{t('home:categories.unavailable')}</p>
              ) : null}

              {workflowsQuery.isLoading || runsQuery.isLoading || categoriesQuery.isLoading ? (
                <Notice className="mt-5" text={t('home:boards.loading')} />
              ) : libraryUnavailable ? (
                <Notice className="mt-5" tone="danger" icon={<AlertTriangle className="size-4" aria-hidden="true" />} text={t('home:boards.unavailable')} />
              ) : boards.length === 0 ? (
                <Notice className="mt-5" text={t('home:boards.empty')} />
              ) : (
              <div className="mt-6 space-y-7">
                {boardGroups.map((group) => {
                  const category = group.category;
                  const isRenaming = category !== null && renamingCategoryId === category.id;
                  return (
                    <section key={category?.id ?? 'uncategorized'} aria-labelledby={`home-category-${category?.id ?? 'uncategorized'}`}>
                      <div className="flex min-h-9 items-center justify-between gap-3">
                          {isRenaming && category ? (
                            <form className="flex w-full max-w-md gap-2" onSubmit={renameCategory}>
                              <Input className="h-8" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} aria-label={t('home:categories.nameLabel')} disabled={categoriesBusy} /* Focus follows the rename activation. */ /* eslint-disable-line jsx-a11y/no-autofocus */ autoFocus />
                              <Button type="submit" size="compact" disabled={!renameValue.trim() || categoriesBusy}>{t('common:actions.save')}</Button>
                              <Button type="button" variant="secondary" size="compact" disabled={categoriesBusy} onClick={() => setRenamingCategoryId(null)}>{t('common:actions.cancel')}</Button>
                            </form>
                          ) : (
                            <h2 id={`home-category-${category?.id ?? 'uncategorized'}`} className="text-sm font-semibold">
                              {category ? category.name : t('home:categories.uncategorized')}
                            </h2>
                          )}

                          {category && !isRenaming ? (
                            <span className="flex items-center gap-1">
                              <Button type="button" variant="ghost" size="icon-compact" disabled={categoriesBusy} aria-label={t('home:categories.addBoards', { name: category.name })} onClick={() => setAddingCategory(category)}>
                                <Plus className="size-4" />
                              </Button>
                              <Button type="button" variant="ghost" size="icon-compact" disabled={categoriesBusy} aria-label={t('home:categories.rename', { name: category.name })} onClick={() => { setRenamingCategoryId(category.id); setRenameValue(category.name); }}>
                                <Pencil className="size-4" />
                              </Button>
                              <Button type="button" variant="ghost" size="icon-compact" disabled={categoriesBusy} aria-label={t('home:categories.delete', { name: category.name })} onClick={() => setDeletingCategory(category)}>
                                <Trash2 className="size-4" />
                              </Button>
                            </span>
                          ) : null}
                        </div>

                        {group.boards.length === 0 ? (
                          <p className="mt-3 rounded-xl border border-dashed border-border bg-surface/60 px-4 py-5 text-[13px] text-muted-foreground">{t('home:categories.empty')}</p>
                        ) : (
                          <div className="wl-stagger mt-3 grid gap-3 md:grid-cols-2">
                            {group.boards.map((board) => (
                              <BoardCard key={board.workflow.id} board={board} />
                            ))}
                          </div>
                        )}
                      </section>
                    );
                  })}
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog
        open={createCategoryOpen}
        onOpenChange={(open) => { if (!createCategoryMutation.isPending) setCreateCategoryOpen(open); }}
      >
        <DialogContent aria-busy={createCategoryMutation.isPending}>
          <DialogHeader>
            <DialogTitle>{t('home:categories.createTitle')}</DialogTitle>
            <DialogDescription>{t('home:categories.createDescription')}</DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={createCategory}>
            <div className="grid gap-2">
              <Label htmlFor="home-category-name">{t('home:categories.nameLabel')}</Label>
              <Input
                id="home-category-name"
                value={newCategoryName}
                onChange={(event) => setNewCategoryName(event.target.value)}
                placeholder={t('home:categories.namePlaceholder')}
                disabled={createCategoryMutation.isPending}
                /* Focus follows the dialog's create-category activation. */
                /* eslint-disable-next-line jsx-a11y/no-autofocus */
                autoFocus
              />
            </div>
            {createCategoryMutation.isError ? (
              <p className="rounded-md border border-danger/25 bg-danger-subtle px-3 py-2 text-[13px] text-danger" role="alert">{t('home:categories.unavailable')}</p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="secondary" size="compact" disabled={createCategoryMutation.isPending} onClick={() => setCreateCategoryOpen(false)}>
                {t('common:actions.cancel')}
              </Button>
              <Button type="submit" size="compact" disabled={!newCategoryName.trim() || createCategoryMutation.isPending}>
                {createCategoryMutation.isPending ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <Plus className="size-4" aria-hidden="true" />}
                {t('home:categories.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={addingCategory !== null}
        onOpenChange={(open) => { if (!assignBoardMutation.isPending) setAddingCategory(open ? addingCategory : null); }}
      >
        <DialogContent aria-busy={assignBoardMutation.isPending}>
          <DialogHeader>
            <DialogTitle>{t('home:categories.addTitle', { name: addingCategory?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('home:categories.addDescription')}</DialogDescription>
          </DialogHeader>
          {assignBoardMutation.isError ? (
            <p className="rounded-md border border-danger/25 bg-danger-subtle px-3 py-2 text-[13px] text-danger" role="alert">{t('home:categories.unavailable')}</p>
          ) : null}
          <div className="grid max-h-[60vh] gap-2 overflow-y-auto">
            {boards.length === 0 ? (
              <p className="mt-3 rounded-xl border border-dashed border-border bg-surface/60 px-4 py-5 text-[13px] text-muted-foreground">{t('home:categories.addEmpty')}</p>
            ) : boards.map((board) => {
              const added = boardCategories.get(board.workflow.id)?.id === addingCategory?.id;
              return (
                <button
                  key={board.workflow.id}
                  type="button"
                  aria-pressed={added}
                  disabled={assignBoardMutation.isPending}
                  className={cn(
                    'flex min-w-0 items-start gap-3 rounded-lg border p-3 text-left',
                    surfaceInteraction,
                    focusRingInset,
                    added ? 'border-brand/40 bg-brand-subtle' : 'border-border bg-surface hover:bg-surface-subtle',
                  )}
                  onClick={() => assignBoard(board.workflow.id, added ? null : addingCategory?.id ?? null)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{board.workflow.name}</span>
                  </span>
                  {added ? (
                    <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-foreground">{t('home:categories.added')}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deletingCategory !== null}
        onOpenChange={(open) => { if (!open && !deleteBusy) setDeletingCategory(null); }}
        title={t('home:categories.deleteTitle', { name: deletingCategory?.name ?? '' })}
        description={t('home:categories.deleteDescription')}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        busyLabel={t('home:categories.deleting')}
        busy={deleteBusy}
        error={deleteCategoryMutation.isError ? t('home:categories.unavailable') : undefined}
        onConfirm={() => void deleteCategory()}
      />
    </div>
  );
}

const BOARD_TABLE_PAGE_SIZE = 5;
const BOARD_TABLE_COLUMNS = 3;

function BoardCardHeaderElement({ element, items, t, locale }: { element: WorkflowDashboardElement; items: unknown[]; t: TFunction<'home'>; locale: AppLocale }) {
  if (element.kind === 'text') return <span className="mt-1 block truncate text-[13px] leading-5 text-muted-foreground">{element.text}</span>;
  if (element.kind === 'count') return <span className="mt-1 block text-[13px] leading-5 text-muted-foreground">{element.label}: <span className="font-medium text-foreground">{formatNumber(items.length, locale)}</span></span>;
  if (element.kind === 'metric') {
    const source = items.length > 0 && isRecord(items[0]) ? items[0] : null;
    const field: WorkflowDashboardField = { key: element.field, label: element.label, type: element.type };
    return <span className="mt-1 block truncate text-[13px] leading-5 text-muted-foreground">{element.label}: <span className="font-medium text-foreground">{source ? formatFieldValue(field, source[element.field], t, locale) : t('boards.emptyValue')}</span></span>;
  }
  return null;
}

function BoardCard({ board }: { board: HomeBoard }) {
  const { t } = useTranslation('home');
  const { locale } = useLocale();
  const [page, setPage] = useState(0);
  const runDetailQuery = useRunQuery('personal', board.run.id, true);
  const output = runDetailQuery.data ? findDashboardOutput(board.dashboard, runDetailQuery.data) : undefined;
  const listElement = dashboardListElement(board.dashboard);
  const items = runDetailQuery.isSuccess && output !== undefined ? outputItems(output) : [];
  const pageCount = Math.max(1, Math.ceil(items.length / BOARD_TABLE_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageItems = items.slice(currentPage * BOARD_TABLE_PAGE_SIZE, (currentPage + 1) * BOARD_TABLE_PAGE_SIZE);
  const tableFields = listElement ? listTableFields(listElement) : [];
  const headerElements = board.dashboard.layout.header.filter((element) => element.kind !== 'list');

  return (
    <article className="flex w-full min-w-0 flex-col items-stretch gap-3 rounded-xl border border-border bg-surface p-4 shadow-xs transition-[box-shadow,border-color] duration-[200ms] ease-[var(--ease-out)] hover:border-foreground/10 hover:shadow-sm">
      <header className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-brand-subtle text-brand" aria-hidden="true">
          <LayoutDashboard className="size-[18px]" />
        </span>
        <span className="min-w-0">
          {headerElements.map((element, index) => (
            <BoardCardHeaderElement key={index} element={element} items={items} t={t} locale={locale} />
          ))}
        </span>
        <span className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{t('boards.version', { version: board.workflow.latestVersion })}</span>
          <span>{formatDateTime(board.run.startedAt, locale)}</span>
          <StatusBadge status={statusLabel(board.run.status)} />
        </span>
      </header>

      {runDetailQuery.isPending ? (
        <p className="border-t border-border pt-2 text-[13px] text-muted-foreground">{t('boards.loading')}</p>
      ) : !listElement || runDetailQuery.isError || output === undefined || items.length === 0 ? (
        <p className="border-t border-border pt-2 text-[13px] text-muted-foreground">{t('boards.emptyOutput')}</p>
      ) : (
        <div className="border-t border-border pt-2">
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full table-fixed border-collapse text-left text-[13px]">
              <thead>
                <tr className="border-b border-border bg-background">
                  {tableFields.map((field) => (
                    <th key={field.key} scope="col" className="truncate px-3 py-2 text-xs font-medium text-muted-foreground">{field.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pageItems.map((item, index) => {
                  const href = itemUrl(listElement, item);
                  const openItem = href ? () => window.open(href, '_blank', 'noopener,noreferrer') : undefined;
                  return (
                    <tr
                      key={index}
                      className={cn(href && 'cursor-pointer transition-colors duration-[120ms] hover:bg-surface-subtle')}
                      onClick={openItem}
                    >
                      {isRecord(item) ? tableFields.map((field) => {
                        const content = formatFieldValue(field, item[field.key], t, locale);
                        return (
                          <td key={field.key} className="truncate px-3 py-2">
                            {field === listTableFields(listElement)[0] && href ? (
                              <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline" onClick={(event) => event.stopPropagation()}>{content}</a>
                            ) : content}
                          </td>
                        );
                      }) : (
                        <td colSpan={BOARD_TABLE_COLUMNS} className="px-3 py-2">
                          <pre className="max-h-32 overflow-auto rounded-md border border-border bg-surface-subtle p-2 text-xs whitespace-pre-wrap font-mono">{JSON.stringify(item, null, 2)}</pre>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {pageCount > 1 ? (
            <nav className="mt-2 flex items-center justify-center gap-2" aria-label={t('boards.pageIndicator', { current: currentPage + 1, total: pageCount })}>
              <Button
                type="button"
                variant="ghost"
                size="icon-compact"
                aria-label={t('boards.previousPage')}
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
              </Button>
              <span className="text-xs text-muted-foreground">
                {t('boards.pageIndicator', { current: currentPage + 1, total: pageCount })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-compact"
                aria-label={t('boards.nextPage')}
                disabled={currentPage === pageCount - 1}
                onClick={() => setPage(currentPage + 1)}
              >
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </nav>
          ) : null}
        </div>
      )}
    </article>
  );
}

function listTableFields(element: Extract<WorkflowDashboardElement, { kind: 'list' }>): WorkflowDashboardField[] {
  const titleField = listTitleField(element);
  const fields = titleField ? [titleField, ...listSecondaryFields(element)] : listSecondaryFields(element);
  return fields.slice(0, BOARD_TABLE_COLUMNS);
}

function dashboardListElement(dashboard: WorkflowDashboardBinding): Extract<WorkflowDashboardElement, { kind: 'list' }> | null {
  for (const region of ['main', 'header', 'footer'] as const) {
    const element = dashboard.layout[region].find((item) => item.kind === 'list');
    if (element) return element;
  }
  return null;
}

function outputItems(output: unknown): unknown[] {
  return Array.isArray(output) ? output : [output];
}

function listTitleField(element: Extract<WorkflowDashboardElement, { kind: 'list' }>): WorkflowDashboardField | undefined {
  if (!element.titleKey) return element.fields[0];
  return element.fields.find((field) => field.key === element.titleKey) ?? element.fields[0];
}

function listSecondaryFields(element: Extract<WorkflowDashboardElement, { kind: 'list' }>): WorkflowDashboardField[] {
  const titleField = listTitleField(element);
  return element.fields.filter((field) => field !== titleField && field.type !== 'url');
}

function findDashboardOutput(dashboard: WorkflowDashboardBinding, run: RunView): unknown {
  const nodeRun = run.nodeRuns?.find((item) => item.nodeId === dashboard.nodeId && item.type === 'worklite/dashboard' && item.status === 'succeeded');
  return nodeRun && 'output' in nodeRun ? nodeRun.output : undefined;
}

function formatFieldValue(field: WorkflowDashboardField, value: unknown, t: TFunction<'home'>, locale: AppLocale): string {
  if (value === undefined || value === null || value === '') return t('boards.emptyValue');
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') return t('boards.emptyValue');
    return value ? t('boards.trueValue') : t('boards.falseValue');
  }
  if (field.type === 'datetime') {
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? t('boards.emptyValue') : formatDateTime(date, locale);
  }
  if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return t('boards.emptyValue');
  return field.type === 'number' && typeof value === 'number' ? formatNumber(value, locale) : String(value);
}

function listUrlField(element: Extract<WorkflowDashboardElement, { kind: 'list' }>): WorkflowDashboardField | undefined {
  return element.fields.find((field) => field.type === 'url');
}

function itemUrl(element: Extract<WorkflowDashboardElement, { kind: 'list' }>, item: unknown): string | null {
  if (!isRecord(item)) return null;
  const field = listUrlField(element);
  const value = field ? item[field.key] : item.url;
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type StatusUiStatus = 'queued' | 'running' | 'paused' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled';

function statusLabel(status: RunView['status']): StatusUiStatus {
  if (status === 'succeeded') return 'completed';
  if (status === 'timed_out') return 'failed';
  return status;
}

function Notice({ text, tone = 'neutral', icon, className }: { text: string; tone?: 'neutral' | 'danger'; icon?: ReactNode; className?: string }) {
  return (
    <p className={cn('flex min-h-20 items-center gap-2 rounded-lg border px-4 py-3 text-[13px]', tone === 'danger' ? 'border-danger/30 bg-danger-subtle text-danger' : 'border-border bg-surface text-muted-foreground', className)}>
      {icon}
      <span>{text}</span>
    </p>
  );
}

function FirstUseGuide({ providerConfigured }: { providerConfigured: boolean }) {
  const { t } = useTranslation(['home', 'common']);
  const rowClassName = 'flex min-h-14 items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3';
  const markerClassName = 'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold';

  return (
    <section aria-labelledby="first-use-title">
      <p id="first-use-title" className="text-[13px] text-muted-foreground">{t('home:firstUse.intro')}</p>
      <ol className="mt-3 space-y-2">
        <li className={cn(rowClassName, providerConfigured && 'bg-surface-subtle/50')}>
          <span className={cn(markerClassName, providerConfigured ? 'bg-success-subtle text-success' : 'bg-brand text-brand-foreground')} aria-hidden="true">
            {providerConfigured ? <Check className="size-3.5" /> : '1'}
          </span>
          <span className={cn('min-w-0 flex-1 text-sm font-medium', providerConfigured && 'text-muted-foreground')}>{t('home:firstUse.configureProvider')}</span>
          {providerConfigured ? (
            <span className="text-xs font-medium text-success">{t('common:status.completed')}</span>
          ) : (
            <Button size="compact" asChild>
              <Link to="/model-providers">{t('common:actions.continue')}<ChevronRight /></Link>
            </Button>
          )}
        </li>
        <li className={cn(rowClassName, !providerConfigured && 'bg-surface-subtle/50 text-muted-foreground')}>
          <span className={cn(markerClassName, providerConfigured ? 'bg-brand text-brand-foreground' : 'bg-surface-subtle text-muted-foreground')} aria-hidden="true">2</span>
          <span className="min-w-0 flex-1 text-sm font-medium">{t('home:firstUse.configureChat')}</span>
          {providerConfigured ? (
            <Button size="compact" asChild>
              <Link to="/chat" search={{ view: 'configuration' }}>{t('common:actions.continue')}<ChevronRight /></Link>
            </Button>
          ) : null}
        </li>
      </ol>
    </section>
  );
}
