import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  ChevronDown,
  ChevronRight,
  FileStack,
  LayoutDashboard,
  Pencil,
  Play,
  Plus,
  Trash2,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { greetingPeriod } from '@/i18n/format';
import type { Artifact, Run, Workflow } from '@/mock/data';
import { useArtifactsQuery, useAuditLogsQuery, useWorkflowsQuery, useRunsQuery } from '@/api/queries';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session-store';

type DashboardWidgetType = 'attention' | 'active_runs' | 'workflow_health' | 'recent_workflows' | 'recent_activity' | 'recent_artifacts';
type DashboardTemplate = 'workflow-overview' | 'workflow-health' | 'recent-activity' | 'blank';

type DashboardBoard = {
  id: string;
  categoryId: string;
  name?: string;
  nameKey?: string;
  description?: string;
  descriptionKey?: string;
  template: DashboardTemplate;
  widgets: DashboardWidgetType[];
};

type DashboardCategory = {
  id: string;
  name?: string;
  nameKey?: string;
  boards: DashboardBoard[];
};

type DashboardStore = {
  categoriesByWorkspace: Record<string, DashboardCategory[]>;
  updateCategories: (workspaceKey: string, update: (current: DashboardCategory[]) => DashboardCategory[]) => void;
};

type HomeSearch = {
  assistant?: 'open';
  board?: string;
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

const ALL_WIDGETS: DashboardWidgetType[] = ['attention', 'active_runs', 'workflow_health', 'recent_workflows', 'recent_activity', 'recent_artifacts'];

function createDefaultCategories(): DashboardCategory[] {
  return [
    {
      id: 'category_workflows',
      nameKey: 'dashboard.categories.workflows',
      boards: [
        {
          id: 'board_workflow_overview',
          categoryId: 'category_workflows',
          nameKey: 'dashboard.boards.workflowOverview.title',
          descriptionKey: 'dashboard.boards.workflowOverview.description',
          template: 'workflow-overview',
          widgets: ['attention', 'active_runs', 'recent_workflows', 'recent_activity'],
        },
        {
          id: 'board_workflow_health',
          categoryId: 'category_workflows',
          nameKey: 'dashboard.boards.workflowHealth.title',
          descriptionKey: 'dashboard.boards.workflowHealth.description',
          template: 'workflow-health',
          widgets: ['workflow_health', 'active_runs', 'recent_artifacts'],
        },
        {
          id: 'board_recent_activity',
          categoryId: 'category_workflows',
          nameKey: 'dashboard.boards.recentActivity.title',
          descriptionKey: 'dashboard.boards.recentActivity.description',
          template: 'recent-activity',
          widgets: ['recent_activity', 'recent_workflows', 'recent_artifacts'],
        },
      ],
    },
  ];
}

const DEFAULT_DASHBOARD_CATEGORIES = createDefaultCategories();

const useDashboardStore = create<DashboardStore>((set) => ({
  categoriesByWorkspace: {},
  updateCategories: (workspaceKey, update) =>
    set((state) => ({
      categoriesByWorkspace: {
        ...state.categoriesByWorkspace,
        [workspaceKey]: update(state.categoriesByWorkspace[workspaceKey] ?? createDefaultCategories()),
      },
    })),
}));

export const Route = createFileRoute('/home')({
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    assistant: search.assistant === 'open' ? 'open' : undefined,
    board: typeof search.board === 'string' && search.board.length > 0 ? search.board : undefined,
  }),
  component: HomePage,
});

function HomePage() {
  const { t: translate } = useTranslation(['home', 'workspace', 'common']);
  const t = translate as unknown as Translate;
  const workspaceKey = 'personal';
  const onboardingStep = useSessionStore((state) => state.onboardingStep);
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { data: apiWorkflows = [] } = useWorkflowsQuery(workspaceKey);
  const { data: apiRuns = [] } = useRunsQuery(workspaceKey);
  const { data: apiArtifacts = [] } = useArtifactsQuery(workspaceKey);
  const { data: apiAuditLogs = [] } = useAuditLogsQuery(workspaceKey);
  const categories = useDashboardStore((state) => state.categoriesByWorkspace[workspaceKey] ?? DEFAULT_DASHBOARD_CATEGORIES);
  const updateCategories = useDashboardStore((state) => state.updateCategories);
  const [categoryDialog, setCategoryDialog] = useState<{ mode: 'create' | 'rename'; categoryId?: string } | null>(null);
  const [categoryName, setCategoryName] = useState('');
  const [deleteCategoryId, setDeleteCategoryId] = useState<string | null>(null);
  const [boardDialog, setBoardDialog] = useState<{ categoryId: string } | null>(null);
  const [boardName, setBoardName] = useState('');
  const [boardTemplate, setBoardTemplate] = useState<DashboardTemplate>('blank');
  const [widgetDialogOpen, setWidgetDialogOpen] = useState(false);

  const workspaceWorkflows: Workflow[] = apiWorkflows.map((item) => ({
    id: item.id,
    teamSlug: item.workspaceSlug,
    name: item.name,
    state: item.state,
    stepCount: item.stepCount,
    lastRunStatus: item.lastRunStatus === 'succeeded' ? 'completed' : item.lastRunStatus === 'timed_out' ? 'failed' : item.lastRunStatus,
    lastRunAt: item.lastRunAt,
    updatedAt: item.updatedAt,
    needsAttention: item.state === 'draft' && item.lastRunStatus === 'failed',
  }));
  const workspaceRuns: Run[] = apiRuns.map((item) => ({
    id: item.id,
    teamSlug: item.workspaceSlug,
    workflowId: item.workflowId,
    workflowName: item.workflowName,
    version: item.version,
    status: item.status === 'succeeded' ? 'completed' : item.status === 'timed_out' ? 'failed' : item.status,
    currentStep: item.currentStep,
    startedAt: item.startedAt,
    durationSeconds: item.durationSeconds,
    initiator: item.initiator,
  }));
  const workspaceArtifacts: Artifact[] = apiArtifacts.map((item) => ({ ...item, teamSlug: workspaceKey }));
  const workspaceActivity = apiAuditLogs.map((item) => ({ id: item.id, text: `${item.actor} ${item.action}`, time: item.timestamp }));
  const selectedBoardEntry = categories
    .flatMap((category) => category.boards.map((board) => ({ category, board })))
    .find(({ board }) => board.id === search.board);
  const selectedBoard = selectedBoardEntry?.board;

  function openBoard(boardId: string) {
    void navigate({ to: '/home', search: { board: boardId } });
  }

  function closeBoard() {
    void navigate({ to: '/home', search: {} });
  }

  function updateBoard(boardId: string, update: (board: DashboardBoard) => DashboardBoard) {
    updateCategories(workspaceKey, (current) => current.map((category) => ({
      ...category,
      boards: category.boards.map((board) => (board.id === boardId ? update(board) : board)),
    })));
  }

  function submitCategory() {
    const value = categoryName.trim();
    if (!value) return;
    if (categoryDialog?.mode === 'rename' && categoryDialog.categoryId) {
      updateCategories(workspaceKey, (current) => current.map((category) => (
        category.id === categoryDialog.categoryId ? { ...category, name: value, nameKey: undefined } : category
      )));
    } else {
      updateCategories(workspaceKey, (current) => [...current, { id: `category-${Date.now()}`, name: value, boards: [] }]);
    }
    setCategoryDialog(null);
    setCategoryName('');
  }

  function removeCategory() {
    if (!deleteCategoryId) return;
    const deletedBoardIds = new Set(categories.find((category) => category.id === deleteCategoryId)?.boards.map((board) => board.id));
    updateCategories(workspaceKey, (current) => current.filter((category) => category.id !== deleteCategoryId));
    if (search.board && deletedBoardIds.has(search.board)) closeBoard();
    setDeleteCategoryId(null);
  }

  function submitBoard() {
    const value = boardName.trim();
    if (!value || !boardDialog) return;
    const board: DashboardBoard = {
      id: `board-${Date.now()}`,
      categoryId: boardDialog.categoryId,
      name: value,
      description: t('dashboard.boards.custom.description'),
      template: boardTemplate,
      widgets: getTemplateWidgets(boardTemplate),
    };
    updateCategories(workspaceKey, (current) => current.map((category) => (
      category.id === boardDialog.categoryId ? { ...category, boards: [...category.boards, board] } : category
    )));
    setBoardDialog(null);
    setBoardName('');
    setBoardTemplate('blank');
    openBoard(board.id);
  }

  function addWidget(type: DashboardWidgetType) {
    if (!selectedBoard) return;
    updateBoard(selectedBoard.id, (board) => ({ ...board, widgets: [...board.widgets, type] }));
    setWidgetDialogOpen(false);
  }

  function moveWidget(index: number, direction: -1 | 1) {
    if (!selectedBoard) return;
    updateBoard(selectedBoard.id, (board) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= board.widgets.length) return board;
      const widgets = [...board.widgets];
      const [moved] = widgets.splice(index, 1);
      widgets.splice(nextIndex, 0, moved);
      return { ...board, widgets };
    });
  }

  function removeWidget(index: number) {
    if (!selectedBoard) return;
    updateBoard(selectedBoard.id, (board) => ({ ...board, widgets: board.widgets.filter((_, itemIndex) => itemIndex !== index) }));
  }

  const pageActions = selectedBoard ? (
    <Button variant="ghost" size="compact" onClick={closeBoard}><ArrowLeft className="size-4" />{t('dashboard.actions.backToDashboards')}</Button>
  ) : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <WorkspaceChrome crumbs={[{ label: t('workspace:nav.home') }]} actions={pageActions} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1200px] px-6 pb-36 pt-6">
          {onboardingStep !== 'complete' ? <FirstUseGuide /> : null}
          {selectedBoard && selectedBoardEntry ? (
            <DashboardDetail board={selectedBoard} category={selectedBoardEntry.category} workflows={workspaceWorkflows} runs={workspaceRuns} artifacts={workspaceArtifacts} activity={workspaceActivity} t={t} onAddWidget={() => setWidgetDialogOpen(true)} onMoveWidget={moveWidget} onRemoveWidget={removeWidget} onRename={(name) => updateBoard(selectedBoard.id, (board) => ({ ...board, name, nameKey: undefined }))} />
          ) : (
            <DashboardLibrary categories={categories} workflows={workspaceWorkflows} runs={workspaceRuns} artifacts={workspaceArtifacts} activity={workspaceActivity} t={t} onOpenBoard={openBoard} onAddCategory={() => { setCategoryDialog({ mode: 'create' }); setCategoryName(''); }} onAddBoard={(categoryId) => { setBoardDialog({ categoryId }); setBoardName(''); setBoardTemplate('blank'); }} onRenameCategory={(category) => { setCategoryDialog({ mode: 'rename', categoryId: category.id }); setCategoryName(resolveCategoryName(category, t)); }} onDeleteCategory={setDeleteCategoryId} />
          )}
        </div>
      </div>

      <Dialog open={Boolean(categoryDialog)} onOpenChange={(open) => !open && setCategoryDialog(null)}>
        <DialogContent><DialogHeader><DialogTitle>{t(categoryDialog?.mode === 'rename' ? 'dashboard.category.renameTitle' : 'dashboard.category.createTitle')}</DialogTitle><DialogDescription>{t('dashboard.category.description')}</DialogDescription></DialogHeader><label htmlFor="dashboard-category-name" className="text-sm font-medium">{t('dashboard.category.nameLabel')}</label><Input id="dashboard-category-name" value={categoryName} onChange={(event) => setCategoryName(event.target.value)} autoFocus /><DialogFooter><Button variant="secondary" onClick={() => setCategoryDialog(null)}>{t('common:actions.cancel')}</Button><Button onClick={submitCategory} disabled={!categoryName.trim()}>{t('common:actions.save')}</Button></DialogFooter></DialogContent>
      </Dialog>
      <Dialog open={Boolean(boardDialog)} onOpenChange={(open) => !open && setBoardDialog(null)}>
        <DialogContent><DialogHeader><DialogTitle>{t('dashboard.board.createTitle')}</DialogTitle><DialogDescription>{t('dashboard.board.createDescription')}</DialogDescription></DialogHeader><label htmlFor="dashboard-board-name" className="text-sm font-medium">{t('dashboard.board.nameLabel')}</label><Input id="dashboard-board-name" value={boardName} onChange={(event) => setBoardName(event.target.value)} autoFocus /><label htmlFor="dashboard-board-template" className="text-sm font-medium">{t('dashboard.board.templateLabel')}</label><Select value={boardTemplate} onValueChange={(value) => setBoardTemplate(value as DashboardTemplate)}><SelectTrigger id="dashboard-board-template"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="blank">{t('dashboard.templates.blank')}</SelectItem><SelectItem value="workflow-overview">{t('dashboard.templates.workflowOverview')}</SelectItem><SelectItem value="workflow-health">{t('dashboard.templates.workflowHealth')}</SelectItem><SelectItem value="recent-activity">{t('dashboard.templates.recentActivity')}</SelectItem></SelectContent></Select><DialogFooter><Button variant="secondary" onClick={() => setBoardDialog(null)}>{t('common:actions.cancel')}</Button><Button onClick={submitBoard} disabled={!boardName.trim()}>{t('dashboard.actions.createBoard')}</Button></DialogFooter></DialogContent>
      </Dialog>
      <Dialog open={Boolean(deleteCategoryId)} onOpenChange={(open) => !open && setDeleteCategoryId(null)}>
        <DialogContent><DialogHeader><DialogTitle>{t('dashboard.category.deleteTitle')}</DialogTitle><DialogDescription>{t('dashboard.category.deleteDescription')}</DialogDescription></DialogHeader><DialogFooter><Button variant="secondary" onClick={() => setDeleteCategoryId(null)}>{t('common:actions.cancel')}</Button><Button variant="destructive" onClick={removeCategory}>{t('common:actions.delete')}</Button></DialogFooter></DialogContent>
      </Dialog>
      <Dialog open={widgetDialogOpen} onOpenChange={setWidgetDialogOpen}>
        <DialogContent><DialogHeader><DialogTitle>{t('dashboard.widget.addTitle')}</DialogTitle><DialogDescription>{t('dashboard.widget.addDescription')}</DialogDescription></DialogHeader><div className="grid gap-2 sm:grid-cols-2">{ALL_WIDGETS.map((widget) => <Button key={widget} variant="secondary" className="justify-start" onClick={() => addWidget(widget)}>{getWidgetIcon(widget, 'size-4')}{t(`dashboard.widgets.${widget}.title`)}</Button>)}</div></DialogContent>
      </Dialog>
    </div>
  );
}

function DashboardLibrary({ categories, workflows, runs, artifacts, activity, t, onOpenBoard, onAddCategory, onAddBoard, onRenameCategory, onDeleteCategory }: { categories: DashboardCategory[]; workflows: Workflow[]; runs: Run[]; artifacts: Artifact[]; activity: { id: string; text: string; time: string }[]; t: Translate; onOpenBoard: (boardId: string) => void; onAddCategory: () => void; onAddBoard: (categoryId: string) => void; onRenameCategory: (category: DashboardCategory) => void; onDeleteCategory: (categoryId: string) => void }) {
  const [openCategories, setOpenCategories] = useState<Record<string, boolean>>({});

  return (
    <>
      <PageHeading title={t('dashboard.title')} description={t('dashboard.description')} />
      <div className="mt-8 flex flex-col gap-10">
        {categories.map((category) => (
          <Collapsible key={category.id} open={openCategories[category.id] ?? true} onOpenChange={(open) => setOpenCategories((current) => ({ ...current, [category.id]: open }))}>
            <div className="flex items-center gap-3">
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-md px-2 py-1 text-left hover:bg-surface-subtle">
                  <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-[180ms]', !(openCategories[category.id] ?? true) && '-rotate-90')} aria-hidden="true" />
                  <LayoutDashboard className="size-4 text-brand" aria-hidden="true" />
                  <span className="truncate text-base font-semibold">{resolveCategoryName(category, t)}</span>
                  <span className="text-xs text-muted-foreground">{t('dashboard.category.boardCount', { count: category.boards.length })}</span>
                </Button>
              </CollapsibleTrigger>
              <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-compact" aria-label={t('dashboard.category.rename')} onClick={() => onRenameCategory(category)}><Pencil className="size-3.5" /></Button></TooltipTrigger><TooltipContent>{t('dashboard.category.rename')}</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-compact" aria-label={t('dashboard.category.delete')} onClick={() => onDeleteCategory(category.id)}><Trash2 className="size-3.5" /></Button></TooltipTrigger><TooltipContent>{t('dashboard.category.delete')}</TooltipContent></Tooltip>
              <Button variant="secondary" size="compact" onClick={() => onAddBoard(category.id)}><Plus className="size-4" />{t('dashboard.actions.addBoard')}</Button>
            </div>
            <CollapsibleContent>
              {category.boards.length === 0 ? <button type="button" className="mt-3 flex min-h-20 w-full cursor-pointer items-center justify-center rounded-lg border border-dashed border-border text-[13px] text-muted-foreground transition-colors duration-[120ms] hover:border-brand hover:bg-brand-subtle hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background" onClick={() => onAddBoard(category.id)}><Plus className="mr-2 size-4" />{t('dashboard.emptyCategory')}</button> : <div className="mt-3 grid gap-3 md:grid-cols-2">{category.boards.map((board) => <button key={board.id} type="button" className="group flex min-h-28 cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface p-4 text-left transition-[border-color,background-color,box-shadow] duration-[120ms] hover:border-brand/50 hover:bg-surface-subtle hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background" onClick={() => onOpenBoard(board.id)}><span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-brand-subtle text-brand" aria-hidden="true"><LayoutDashboard className="size-[18px]" /></span><span className="min-w-0 flex-1"><span className="flex items-center gap-2 text-sm font-semibold"><span className="truncate">{resolveBoardName(board, t)}</span><ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100" aria-hidden="true" /></span><span className="mt-1 block text-[13px] leading-5 text-muted-foreground">{resolveBoardDescription(board, t)}</span><BoardSummary board={board} workflows={workflows} runs={runs} artifacts={artifacts} t={t} /></span><ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /></button>)}</div>}
            </CollapsibleContent>
          </Collapsible>
        ))}
      </div>
      <div className="mt-8 border-t border-border pt-4"><Button variant="ghost" size="compact" onClick={onAddCategory}><Plus className="size-4" />{t('dashboard.actions.addCategory')}</Button></div>
    </>
  );
}

function BoardSummary({ board, workflows, runs, artifacts, t }: { board: DashboardBoard; workflows: Workflow[]; runs: Run[]; artifacts: Artifact[]; t: Translate }) {
  const attentionCount = workflows.filter((workflow) => workflow.needsAttention).length;
  const activeRunCount = runs.filter((run) => run.status === 'running' || run.status === 'waiting_for_input').length;
  const metrics: Array<{ key: string; value: number; icon: ReactNode }> = [
    { key: 'workflows', value: workflows.length, icon: <WorkflowIcon className="size-3.5" aria-hidden="true" /> },
  ];
  if (board.widgets.includes('attention')) metrics.push({ key: 'attention', value: attentionCount, icon: <AlertTriangle className="size-3.5" aria-hidden="true" /> });
  if (board.widgets.includes('active_runs')) metrics.push({ key: 'activeRuns', value: activeRunCount, icon: <Play className="size-3.5" aria-hidden="true" /> });
  if (board.widgets.includes('recent_artifacts')) metrics.push({ key: 'artifacts', value: artifacts.length, icon: <FileStack className="size-3.5" aria-hidden="true" /> });
  return <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground">{metrics.map((metric) => <span key={metric.key} className="inline-flex items-center gap-1.5">{metric.icon}<span>{t(`dashboard.summary.${metric.key}`, { count: metric.value })}</span></span>)}</div>;
}

function DashboardDetail({ board, category, workflows, runs, artifacts, activity, t, onAddWidget, onMoveWidget, onRemoveWidget, onRename }: { board: DashboardBoard; category: DashboardCategory; workflows: Workflow[]; runs: Run[]; artifacts: Artifact[]; activity: { id: string; text: string; time: string }[]; t: Translate; onAddWidget: () => void; onMoveWidget: (index: number, direction: -1 | 1) => void; onRemoveWidget: (index: number) => void; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(resolveBoardName(board, t));
  function saveName() { const value = name.trim(); if (value) onRename(value); setEditing(false); }

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><p className="text-[13px] text-muted-foreground">{resolveCategoryName(category, t)}</p>{editing ? <div className="mt-1 flex max-w-xl items-center gap-2"><Input value={name} onChange={(event) => setName(event.target.value)} aria-label={t('dashboard.board.nameLabel')} autoFocus /><Button size="compact" onClick={saveName}>{t('common:actions.save')}</Button></div> : <h1 className="mt-1 text-2xl font-semibold tracking-tight">{resolveBoardName(board, t)}</h1>}<p className="mt-2 max-w-2xl text-[13px] text-muted-foreground">{resolveBoardDescription(board, t)}</p></div><div className="flex items-center gap-2"><Button variant="secondary" size="compact" onClick={() => setEditing((value) => !value)}><Pencil className="size-4" />{editing ? t('common:actions.cancel') : t('dashboard.actions.editBoard')}</Button><Button size="compact" onClick={onAddWidget}><Plus className="size-4" />{t('dashboard.actions.addWidget')}</Button></div></div>
      {board.widgets.length === 0 ? <div className="mt-8 flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 text-center"><LayoutDashboard className="size-6 text-muted-foreground" aria-hidden="true" /><h2 className="mt-3 text-sm font-semibold">{t('dashboard.widget.emptyTitle')}</h2><p className="mt-1 max-w-sm text-[13px] text-muted-foreground">{t('dashboard.widget.emptyDescription')}</p><Button className="mt-4" size="compact" onClick={onAddWidget}><Plus className="size-4" />{t('dashboard.actions.addWidget')}</Button></div> : <div className="mt-8 grid gap-4 md:grid-cols-2">{board.widgets.map((widget, index) => <DashboardWidget key={`${widget}-${index}`} type={widget} index={index} workflows={workflows} runs={runs} artifacts={artifacts} activity={activity} t={t} onMove={onMoveWidget} onRemove={onRemoveWidget} />)}</div>}
    </>
  );
}

function DashboardWidget({ type, index, workflows, runs, artifacts, activity, t, onMove, onRemove }: { type: DashboardWidgetType; index: number; workflows: Workflow[]; runs: Run[]; artifacts: Artifact[]; activity: { id: string; text: string; time: string }[]; t: Translate; onMove: (index: number, direction: -1 | 1) => void; onRemove: (index: number) => void }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-surface" aria-labelledby={`dashboard-widget-${index}`}>
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3"><div className="flex min-w-0 items-center gap-2">{getWidgetIcon(type, 'size-4 text-brand')}<h2 id={`dashboard-widget-${index}`} className="truncate text-sm font-semibold">{t(`dashboard.widgets.${type}.title`)}</h2></div><div className="flex shrink-0 items-center gap-1"><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-compact" aria-label={t('dashboard.widget.moveUp')} onClick={() => onMove(index, -1)} disabled={index === 0}><ChevronDown className="size-3.5 rotate-180" /></Button></TooltipTrigger><TooltipContent>{t('dashboard.widget.moveUp')}</TooltipContent></Tooltip><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-compact" aria-label={t('dashboard.widget.moveDown')} onClick={() => onMove(index, 1)}><ChevronDown className="size-3.5" /></Button></TooltipTrigger><TooltipContent>{t('dashboard.widget.moveDown')}</TooltipContent></Tooltip><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-compact" aria-label={t('dashboard.widget.remove')} onClick={() => onRemove(index)}><Trash2 className="size-3.5" /></Button></TooltipTrigger><TooltipContent>{t('dashboard.widget.remove')}</TooltipContent></Tooltip>{type === 'active_runs' ? <WidgetLink to="/runs">{t('dashboard.actions.viewAll')}</WidgetLink> : null}{type === 'recent_artifacts' ? <WidgetLink to="/artifacts">{t('dashboard.actions.viewAll')}</WidgetLink> : null}{type === 'recent_workflows' || type === 'workflow_health' ? <WidgetLink to="/workflows">{t('dashboard.actions.viewAll')}</WidgetLink> : null}</div></div>
      <div className="min-h-36">{renderWidgetContent(type, { workflows, runs, artifacts, activity, t })}</div>
    </section>
  );
}

function renderWidgetContent(type: DashboardWidgetType, data: { workflows: Workflow[]; runs: Run[]; artifacts: Artifact[]; activity: { id: string; text: string; time: string }[]; t: Translate }) {
  if (type === 'attention') {
    const items = data.workflows.filter((workflow) => workflow.needsAttention);
    return items.length === 0 ? <WidgetEmpty text={data.t('dashboard.widgets.attention.empty')} /> : <div className="divide-y divide-border">{items.map((workflow) => <WorkflowRow key={workflow.id} workflow={workflow} attention />)}</div>;
  }
  if (type === 'active_runs') {
    const items = data.runs.filter((run) => run.status === 'running' || run.status === 'waiting_for_input');
    return items.length === 0 ? <WidgetEmpty text={data.t('dashboard.widgets.active_runs.empty')} /> : <div className="divide-y divide-border">{items.map((run) => <RunRow key={run.id} run={run} />)}</div>;
  }
  if (type === 'workflow_health') {
    return data.workflows.length === 0 ? <WidgetEmpty text={data.t('dashboard.widgets.workflow_health.empty')} /> : <div className="divide-y divide-border">{data.workflows.map((workflow) => <WorkflowRow key={workflow.id} workflow={workflow} />)}</div>;
  }
  if (type === 'recent_workflows') {
    return data.workflows.length === 0 ? <WidgetEmpty text={data.t('dashboard.widgets.recent_workflows.empty')} /> : <div className="divide-y divide-border">{data.workflows.slice(0, 4).map((workflow) => <WorkflowRow key={workflow.id} workflow={workflow} />)}</div>;
  }
  if (type === 'recent_artifacts') {
    return data.artifacts.length === 0 ? <WidgetEmpty text={data.t('dashboard.widgets.recent_artifacts.empty')} /> : <div className="divide-y divide-border">{data.artifacts.slice(0, 4).map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact} />)}</div>;
  }
  return <ul className="divide-y divide-border">{data.activity.map((item) => <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-3 text-[13px]"><span className="min-w-0 truncate">{item.text}</span><span className="shrink-0 tabular-nums text-muted-foreground">{item.time}</span></li>)}</ul>;
}

function WorkflowRow({ workflow, attention = false }: { workflow: Workflow; attention?: boolean }) {
  return <Link to="/workflows/$workflowId" params={{ workflowId: workflow.id }} className="group flex items-center gap-3 px-4 py-3 transition-colors duration-[120ms] hover:bg-surface-subtle focus-visible:outline-none">{attention ? <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden="true" /> : <WorkflowIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}<span className="min-w-0 flex-1 truncate text-[13px] font-medium">{workflow.name}</span><StatusBadge status={workflow.lastRunStatus ?? workflow.state} /><ChevronRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100" aria-hidden="true" /></Link>;
}

function RunRow({ run }: { run: Run }) {
  return <Link to="/runs/$runId" params={{ runId: run.id }} className="group flex items-center gap-3 px-4 py-3 transition-colors duration-[120ms] hover:bg-surface-subtle focus-visible:outline-none"><Play className="size-4 shrink-0 text-brand" aria-hidden="true" /><span className="min-w-0 flex-1 truncate text-[13px] font-medium">{run.workflowName}</span><StatusBadge status={run.status} /><ChevronRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100" aria-hidden="true" /></Link>;
}

function ArtifactRow({ artifact }: { artifact: Artifact }) {
  return <Link to="/artifacts/$artifactId" params={{ artifactId: artifact.id }} className="group flex items-center gap-3 px-4 py-3 transition-colors duration-[120ms] hover:bg-surface-subtle focus-visible:outline-none"><FileStack className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0 flex-1 truncate text-[13px] font-medium">{artifact.name}</span><span className="shrink-0 text-xs text-muted-foreground">{artifact.size}</span><ChevronRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100" aria-hidden="true" /></Link>;
}

function WidgetEmpty({ text }: { text: string }) { return <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">{text}</p>; }

function WidgetLink({ to, children }: { to: '/runs' | '/artifacts' | '/workflows'; children: string }) { return <Link to={to} className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">{children}<ArrowUpRight className="size-3.5" /></Link>; }

function getWidgetIcon(type: DashboardWidgetType, className: string) {
  if (type === 'attention') return <AlertTriangle className={className} aria-hidden="true" />;
  if (type === 'active_runs') return <Play className={className} aria-hidden="true" />;
  if (type === 'workflow_health' || type === 'recent_workflows') return <WorkflowIcon className={className} aria-hidden="true" />;
  if (type === 'recent_artifacts') return <FileStack className={className} aria-hidden="true" />;
  return <BarChart3 className={className} aria-hidden="true" />;
}

function getTemplateWidgets(template: DashboardTemplate): DashboardWidgetType[] {
  if (template === 'workflow-overview') return ['attention', 'active_runs', 'recent_workflows', 'recent_activity'];
  if (template === 'workflow-health') return ['workflow_health', 'active_runs', 'recent_artifacts'];
  if (template === 'recent-activity') return ['recent_activity', 'recent_workflows', 'recent_artifacts'];
  return [];
}

function resolveCategoryName(category: DashboardCategory, t: Translate) { return category.name ?? (category.nameKey ? t(category.nameKey) : ''); }
function resolveBoardName(board: DashboardBoard, t: Translate) { return board.name ?? (board.nameKey ? t(board.nameKey) : 'Dashboard'); }
function resolveBoardDescription(board: DashboardBoard, t: Translate) { return board.description ?? (board.descriptionKey ? t(board.descriptionKey) : t('dashboard.boards.custom.description')); }

function FirstUseGuide() {
  const { t } = useTranslation(['home', 'common']);
  return <div className="mt-8 space-y-3"><p className="text-[13px] text-muted-foreground">{t('firstUse.intro')}</p><Link to="/model-providers" className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 hover:bg-surface-subtle"><span className="text-sm font-medium">{t('firstUse.configureProvider')}</span><Button size="compact" asChild><span>{t('common:actions.continue')}</span></Button></Link><Link to="/agents/$agentId" params={{ agentId: 'new' }} className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 hover:bg-surface-subtle"><span className="text-sm text-muted-foreground">{t('firstUse.createAgent')}</span></Link><Link to="/runs" className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 hover:bg-surface-subtle"><span className="text-sm text-muted-foreground">{t('firstUse.runAndInspect')}</span></Link></div>;
}
