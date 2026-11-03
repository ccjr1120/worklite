import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { AlertCircle, Ban, FileCode2, FileText, Folder, LoaderCircle, LockKeyhole, Play, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { CommandExecutionEvent, CommandExecutionStatus, CommandExecutionView, SkillView } from '@worklite/contracts';
import { api, parseCommandEvent } from '@/api/client';
import { skillsQueryKey, useSkillQuery } from '@/api/queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { focusRingInset, surfaceInteraction } from '@/components/ui/interaction';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { queryClient } from '@/lib/query-client';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/skills/$skillId')({ component: SkillEditorPage });

type PackageFile = SkillView['files'][number];

function SkillEditorPage() {
  const { t } = useTranslation(['skills', 'common']);
  const { skillId } = Route.useParams();
  const navigate = useNavigate();
  const workspaceSlug = 'personal';
  const { data: skill, isLoading, isError } = useSkillQuery(workspaceSlug, skillId);
  const [files, setFiles] = useState<PackageFile[]>([{ path: 'SKILL.md', content: '' }]);
  const [selectedPath, setSelectedPath] = useState('SKILL.md');
  const [argumentsInput, setArgumentsInput] = useState('[]');
  const [argumentError, setArgumentError] = useState('');
  const [execution, setExecution] = useState<CommandExecutionView | null>(null);
  const [executionScriptPath, setExecutionScriptPath] = useState('');
  const [executionEvents, setExecutionEvents] = useState<CommandExecutionEvent[]>([]);
  const [executionError, setExecutionError] = useState('');
  const [streamDisconnected, setStreamDisconnected] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const outputRef = useRef<HTMLDivElement>(null);
  const followingOutputRef = useRef(true);

  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0];
  const packageGroups = useMemo(() => groupPackageFiles(files), [files]);

  useEffect(() => {
    if (!skill) return;
    setFiles(skill.files);
    setSelectedPath(skill.files.some((file) => file.path === 'SKILL.md') ? 'SKILL.md' : skill.files[0]?.path ?? 'SKILL.md');
  }, [skill]);

  const executionId = execution?.id;
  useEffect(() => {
    if (!executionId) return;
    let disposed = false;
    const source = new EventSource(api.commandEventsUrl(executionId));

    const refreshExecution = async () => {
      try {
        const refreshed = await api.command(executionId);
        if (disposed) return;
        setExecution(refreshed);
      } catch (error) {
        if (!disposed) setExecutionError(error instanceof Error ? error.message : t('editor.run.loadFailed'));
      }
    };

    source.onopen = () => {
      if (!disposed) setStreamDisconnected(false);
    };
    source.onmessage = (message) => {
      if (disposed) return;
      try {
        const event = parseCommandEvent(message.data);
        setExecutionEvents((current) => current.some((item) => item.sequence === event.sequence) ? current : [...current, event]);
        if (event.type === 'lifecycle') void refreshExecution();
      } catch {
        setStreamDisconnected(true);
      }
    };
    source.addEventListener('complete', () => {
      source.close();
      if (!disposed) { setStreamDisconnected(false); void refreshExecution(); }
    });
    source.onerror = () => {
      if (!disposed) setStreamDisconnected(true);
    };

    void refreshExecution();
    return () => {
      disposed = true;
      source.close();
    };
  }, [executionId, t]);

  useEffect(() => {
    const output = outputRef.current;
    if (output && followingOutputRef.current) output.scrollTop = output.scrollHeight;
  }, [executionEvents]);

  async function runSelectedScript() {
    if (!skill || skill.validation !== 'valid' || !selectedFile || !selectedFile.path.startsWith('scripts/') || launching) return;
    setArgumentError('');
    setExecutionError('');
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(argumentsInput);
    } catch {
      setArgumentError(t('editor.run.invalidArguments'));
      return;
    }
    if (!Array.isArray(argumentsValue) || argumentsValue.some((value) => typeof value !== 'string')) {
      setArgumentError(t('editor.run.invalidArguments'));
      return;
    }

    setLaunching(true);
    setExecutionEvents([]);
    setStreamDisconnected(false);
    followingOutputRef.current = true;
    try {
      const started = await api.executeSkillScript(workspaceSlug, skill.id, { scriptPath: selectedFile.path, arguments: argumentsValue });
      setExecutionScriptPath(selectedFile.path);
      setExecution(started);
    } catch (error) {
      setExecutionError(error instanceof Error ? error.message : t('editor.run.startFailed'));
    } finally {
      setLaunching(false);
    }
  }

  async function cancelExecution() {
    if (!execution || cancelling) return;
    setCancelling(true);
    setExecutionError('');
    try {
      setExecution(await api.cancelCommand(execution.id));
    } catch (error) {
      setExecutionError(error instanceof Error ? error.message : t('editor.run.cancelFailed'));
    } finally {
      setCancelling(false);
    }
  }

  async function deleteSkill() {
    if (!skill || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await api.deleteSkill(workspaceSlug, skillId);
      setDeleteOpen(false);
      toast.success(t('delete.success'));
      await queryClient.invalidateQueries({ queryKey: skillsQueryKey() });
      void navigate({ to: '/skills' });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t('delete.failed'));
    } finally {
      setDeleteBusy(false);
    }
  }

  if (isLoading) return <ResourceState icon={LoaderCircle} message={t('editor.loading')} animated />;
  if (isError) return <ResourceState icon={AlertCircle} message={t('editor.loadFailed')} error />;

  const CapabilityIcon = FileCode2;
  const selectedIsScript = selectedFile?.path.startsWith('scripts/');
  const selectedIsExecutable = Boolean(selectedIsScript && selectedFile?.content.startsWith('#!'));
  const executionActive = execution?.status === 'queued' || execution?.status === 'running' || execution?.status === 'cancelling';
  const canRun = Boolean(skill?.validation === 'valid' && selectedIsExecutable && !launching && !executionActive);

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <WorkspaceChrome
        crumbs={[{ label: t('title'), to: '/skills' }, { label: skill?.name ?? t('editor.fallback') }]}
        status={<span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground"><LockKeyhole className="size-3.5" aria-hidden="true" />{t('editor.readOnly')}</span>}
        actions={skill ? <Button type="button" variant="ghost" size="icon-compact" aria-label={t('delete.action', { name: skill.name })} title={t('delete.action', { name: skill.name })} onClick={() => { setDeleteError(''); setDeleteOpen(true); }}><Trash2 className="size-4" /></Button> : null}
      />

      <aside className="max-h-72 w-full shrink-0 overflow-auto border-b border-border bg-surface p-4 md:max-h-none md:w-72 md:border-b-0 md:border-r">
        <div className="flex items-start gap-2">
          <CapabilityIcon className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
          <div className="min-w-0"><p className="truncate text-sm font-semibold">{skill?.name}</p><p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{skill ? t('rootPath', { root: skill.rootPath, directory: skill.directory }) : ''}</p></div>
        </div>

        <div className="mt-5">
          <div className="flex min-h-8 items-center justify-between gap-2 px-1">
            <p className="text-xs font-medium text-muted-foreground">{t('editor.package')}</p>
          </div>
          <PackageTree groups={packageGroups} selectedPath={selectedFile?.path} onSelect={setSelectedPath} />
        </div>

        {skill ? (
          <div className="mt-5 border-t border-border pt-4">
            <div className="flex flex-wrap gap-2">
              <Badge variant="neutral">{t(`root.${skill.root}`)}</Badge>
              {skill.version ? <Badge variant="neutral">{skill.version}</Badge> : null}
              {skill.conflict ? <Badge variant="warning">{t('conflict.title')}</Badge> : null}
              {skill.validation === 'invalid' ? <Badge variant="warning">{t('invalid.title')}</Badge> : null}
            </div>
            <div className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
              <p>{t('editor.localReadOnly')}</p>
              {skill.description ? <p>{skill.description}</p> : null}
              {skill.conflict ? <p className="text-warning">{skill.conflict.reason}<br />{skill.conflict.ignoredPath}</p> : null}
              {skill.validation === 'invalid' && skill.validationReason ? <p className="text-warning">{skill.validationReason}</p> : null}
              {Array.isArray(skill.metadata?.bins) ? <p>{t('editor.localBins', { bins: (skill.metadata.bins as string[]).join(', ') })}</p> : null}
            </div>
          </div>
        ) : null}
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <header className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4">
          <span className="truncate font-mono text-xs text-muted-foreground">{selectedFile?.path ?? 'SKILL.md'}</span>
          <span className="flex items-center gap-2">
            {selectedIsScript ? <Badge variant={selectedFile.content.startsWith('#!') ? 'success' : 'warning'}>{selectedFile.content.startsWith('#!') ? t('editor.executable') : t('editor.missingShebang')}</Badge> : null}
            {selectedIsScript ? (
              <Button type="button" size="compact" disabled={!canRun} onClick={() => void runSelectedScript()}>
                {launching ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
                {t('editor.run.action')}
              </Button>
            ) : null}
          </span>
        </header>
        {selectedIsScript ? (
          <div className="shrink-0 border-b border-warning/30 bg-warning/5 px-4 py-2.5">
            <p className="text-xs text-warning">{t('editor.scriptWarning')}</p>
            <div className="mt-2 flex flex-wrap items-start gap-2">
              <div className="min-w-[16rem] flex-1">
                <label htmlFor="skill-script-arguments" className="text-xs font-medium text-foreground">{t('editor.run.arguments')}</label>
                <Input
                  id="skill-script-arguments"
                  className="mt-1 h-8 font-mono text-xs"
                  value={argumentsInput}
                  onChange={(event) => { setArgumentsInput(event.target.value); setArgumentError(''); }}
                  placeholder='["value"]'
                  aria-invalid={Boolean(argumentError)}
                />
                {argumentError ? <p className="mt-1 text-xs text-danger" role="alert">{argumentError}</p> : <p className="mt-1 text-xs text-muted-foreground">{t('editor.run.argumentsHint')}</p>}
              </div>
            </div>
          </div>
        ) : null}
        <textarea
          className={cn('min-h-80 flex-1 resize-none border-0 bg-background p-4 font-mono text-[13px] leading-6 text-foreground disabled:cursor-default disabled:opacity-100', surfaceInteraction, focusRingInset)}
          value={selectedFile?.content ?? ''}
          readOnly
          spellCheck={false}
          aria-label={selectedFile?.path ?? 'SKILL.md'}
        />
        {execution ? (
          <section className="flex h-64 shrink-0 flex-col border-t border-border bg-surface" aria-label={t('editor.run.output')}>
            <header className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <FileCode2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate font-mono text-xs">{executionScriptPath}</span>
                <StatusBadge status={executionBadgeStatus(execution.status)} />
                {execution.exitCode !== null ? <span className="text-xs text-muted-foreground">{t('editor.run.exitCode', { code: execution.exitCode })}</span> : null}
                {execution.signal ? <span className="text-xs text-muted-foreground">{t('editor.run.signal', { signal: execution.signal })}</span> : null}
              </div>
              {executionActive ? (
                <Button type="button" variant="secondary" size="compact" disabled={cancelling} onClick={() => void cancelExecution()}>
                  {cancelling ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <Ban aria-hidden="true" />}
                  {t('editor.run.cancel')}
                </Button>
              ) : null}
            </header>
            {streamDisconnected && executionActive ? <p className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/5 px-4 py-2 text-xs text-warning"><RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />{t('editor.run.reconnecting')}</p> : null}
            <div
              ref={outputRef}
              className="min-h-0 flex-1 overflow-auto bg-background px-4 py-3 font-mono text-xs leading-5"
              onScroll={(event) => {
                const element = event.currentTarget;
                followingOutputRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
              }}
            >
              {executionEvents.length === 0 ? <p className="font-sans text-xs text-muted-foreground">{t('editor.run.emptyOutput')}</p> : executionEvents.map((event) => (
                <div key={event.sequence} className={cn('grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2', event.type === 'lifecycle' && 'my-1 text-muted-foreground')}>
                  <span className="select-none text-right text-[11px] font-medium uppercase text-muted-foreground">{t(`editor.run.${event.type}`)}</span>
                  <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-xs text-foreground">{event.data}</pre>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {executionError ? <p className="shrink-0 border-t border-danger/30 bg-danger/5 px-4 py-2 text-xs text-danger" role="alert">{executionError}</p> : null}
      </main>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(nextOpen) => { setDeleteOpen(nextOpen); if (!nextOpen) setDeleteError(''); }}
        title={t('delete.title', { name: skill?.name ?? '' })}
        description={t('delete.description', { root: skill?.rootPath ?? '', directory: skill?.directory ?? '' })}
        confirmLabel={t('delete.action', { name: skill?.name ?? '' })}
        cancelLabel={t('common:actions.cancel')}
        busyLabel={t('delete.deleting')}
        error={deleteError}
        busy={deleteBusy}
        onConfirm={() => void deleteSkill()}
      />
    </div>
  );
}

function PackageTree({ groups, selectedPath, onSelect }: { groups: ReturnType<typeof groupPackageFiles>; selectedPath?: string; onSelect: (path: string) => void }) {
  return (
    <ul className="mt-2 space-y-1">
      {groups.root.map((file) => <PackageFileButton key={file.path} file={file} selected={selectedPath === file.path} onSelect={onSelect} />)}
      {groups.folders.map((group) => (
        <li key={group.name}>
          <div className="flex min-h-8 items-center gap-2 px-2 py-1.5 font-mono text-xs text-muted-foreground"><Folder className="size-3.5 shrink-0" aria-hidden="true" /><span>{group.name}</span></div>
          <ul className="ml-3 border-l border-border pl-2">{group.files.map((file) => <PackageFileButton key={file.path} file={file} label={file.path.slice(group.name.length + 1)} selected={selectedPath === file.path} onSelect={onSelect} />)}</ul>
        </li>
      ))}
    </ul>
  );
}

function PackageFileButton({ file, label = file.path, selected, onSelect }: { file: PackageFile; label?: string; selected: boolean; onSelect: (path: string) => void }) {
  const Icon = file.path.startsWith('scripts/') ? FileCode2 : FileText;
  return <li><button type="button" onClick={() => onSelect(file.path)} aria-pressed={selected} className={cn('flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs', surfaceInteraction, focusRingInset, selected ? 'bg-brand-subtle text-foreground' : 'text-muted-foreground hover:bg-surface-subtle hover:text-foreground')}><Icon className="size-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{label}</span></button></li>;
}

function groupPackageFiles(files: PackageFile[]) {
  const root = files.filter((file) => !file.path.includes('/'));
  const folders = [...new Set(files.filter((file) => file.path.includes('/')).map((file) => file.path.split('/')[0]!))].sort().map((name) => ({ name, files: files.filter((file) => file.path.startsWith(`${name}/`)).sort((left, right) => left.path.localeCompare(right.path)) }));
  return { root, folders };
}

function executionBadgeStatus(status: CommandExecutionStatus): 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' {
  if (status === 'succeeded') return 'completed';
  if (status === 'cancelling') return 'running';
  return status;
}

function ResourceState({ icon: Icon, message, animated, error }: { icon: typeof LoaderCircle; message: string; animated?: boolean; error?: boolean }) {
  return <div className="flex h-full items-center justify-center p-6" role={error ? 'alert' : 'status'}><p className={cn('flex items-center gap-2 text-sm', error ? 'text-danger' : 'text-muted-foreground')}><Icon className={cn('size-4', animated && 'motion-safe:animate-spin')} aria-hidden="true" />{message}</p></div>;
}
