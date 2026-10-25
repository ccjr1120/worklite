import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { AlertCircle, Ban, FileCode2, FilePlus2, FileText, Folder, LoaderCircle, LockKeyhole, Play, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { CommandExecutionEvent, CommandExecutionStatus, CommandExecutionView, SkillView } from '@worklite/contracts';
import { api, parseCommandEvent } from '@/api/client';
import { skillsQueryKey, useSkillQuery } from '@/api/queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { SaveIndicator } from '@/components/save-indicator';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { focusRingInset, surfaceInteraction } from '@/components/ui/interaction';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { queryClient } from '@/lib/query-client';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/capabilities/skills/$skillId')({ component: SkillEditorPage });

type PackageFile = SkillView['files'][number];

function SkillEditorPage() {
  const { t } = useTranslation(['skills', 'common']);
  const { t: tWorkspace } = useTranslation('workspace');
  const { skillId } = Route.useParams();
  const navigate = useNavigate();
  const workspaceSlug = 'personal';
  const isNew = skillId === 'new';
  const { data: skill, isLoading, isError } = useSkillQuery(workspaceSlug, skillId);
  const [name, setName] = useState('');
  const [files, setFiles] = useState<PackageFile[]>([{ path: 'SKILL.md', content: '' }]);
  const [selectedPath, setSelectedPath] = useState('SKILL.md');
  const [addingFile, setAddingFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState('scripts/');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>(isNew ? 'unsaved' : 'saved');
  const [nameError, setNameError] = useState('');
  const [pathError, setPathError] = useState('');
  const [saveError, setSaveError] = useState('');
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
  const isBuiltIn = skill?.source === 'built-in';
  const isLocal = skill?.source === 'local';
  const readOnlySource = isBuiltIn || isLocal;
  const isTerminalCommand = skill?.id === 'sk_terminal_command';
  const editable = isNew || Boolean(skill && !readOnlySource);
  const packageGroups = useMemo(() => groupPackageFiles(files), [files]);

  useEffect(() => {
    if (!skill) return;
    setName(skill.name);
    setFiles(skill.files);
    setSelectedPath(skill.files.some((file) => file.path === 'SKILL.md') ? 'SKILL.md' : skill.files[0]?.path ?? 'SKILL.md');
    setSaveState('saved');
    setNameError('');
    setPathError('');
    setSaveError('');
  }, [skill]);

  useEffect(() => {
    if (!execution) return;
    let disposed = false;
    const source = new EventSource(api.commandEventsUrl(execution.id));

    const refreshExecution = async () => {
      try {
        const refreshed = await api.command(execution.id);
        if (disposed) return;
        setExecution(refreshed);
        if (isTerminalExecution(refreshed.status)) {
          source.close();
          setStreamDisconnected(false);
        }
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
    source.onerror = () => {
      if (!disposed) setStreamDisconnected(true);
    };

    void refreshExecution();
    return () => {
      disposed = true;
      source.close();
    };
  }, [execution, t]);

  useEffect(() => {
    const output = outputRef.current;
    if (output && followingOutputRef.current) output.scrollTop = output.scrollHeight;
  }, [executionEvents]);

  function markUnsaved() {
    setSaveState('unsaved');
    setSaveError('');
  }

  async function save() {
    const normalizedName = name.trim();
    if (!normalizedName) {
      setNameError(t('editor.nameRequired'));
      return;
    }
    if (!editable || saveState === 'saving') return;
    setNameError('');
    setPathError('');
    setSaveError('');
    setSaveState('saving');
    try {
      const saved = isNew
        ? await api.createSkill(workspaceSlug, { name: normalizedName, source: 'online', files })
        : await api.updateSkill(workspaceSlug, skillId, { name: normalizedName, files });
      queryClient.setQueryData(['skill', saved.id], saved);
      await queryClient.invalidateQueries({ queryKey: ['skills'] });
      setFiles(saved.files);
      setSaveState('saved');
      if (isNew) void navigate({ to: '/capabilities/skills/$skillId', params: { skillId: saved.id }, replace: true });
    } catch (error: unknown) {
      setSaveState('unsaved');
      setSaveError(error instanceof Error ? error.message : t('editor.saveFailed'));
    }
  }

  function addFile(event: FormEvent) {
    event.preventDefault();
    const path = newFilePath.trim();
    if (!isValidNewPath(path)) {
      setPathError(t('editor.pathInvalid'));
      return;
    }
    if (files.some((file) => file.path === path)) {
      setPathError(t('editor.pathDuplicate'));
      return;
    }
    const content = path.startsWith('scripts/') ? '#!/bin/sh\n\n' : '';
    setFiles((current) => [...current, { path, content }].sort((left, right) => left.path.localeCompare(right.path)));
    setSelectedPath(path);
    setAddingFile(false);
    setNewFilePath('scripts/');
    setPathError('');
    markUnsaved();
  }

  function deleteSelectedFile() {
    if (!editable || !selectedFile || selectedFile.path === 'SKILL.md') return;
    setFiles((current) => current.filter((file) => file.path !== selectedFile.path));
    setSelectedPath('SKILL.md');
    markUnsaved();
  }

  async function runSelectedScript() {
    if (!skill || !selectedFile || !selectedFile.path.startsWith('scripts/') || launching) return;
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
    if (isNew || readOnlySource || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await api.deleteSkill(workspaceSlug, skillId);
      setDeleteOpen(false);
      toast.success(t('delete.success'));
      await queryClient.invalidateQueries({ queryKey: skillsQueryKey() });
        void navigate({ to: '/capabilities' });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t('delete.failed'));
    } finally {
      setDeleteBusy(false);
    }
  }

  if (!isNew && isLoading) return <ResourceState icon={LoaderCircle} message={t('editor.loading')} animated />;
  if (!isNew && isError) return <ResourceState icon={AlertCircle} message={t('editor.loadFailed')} error />;

  const CapabilityIcon = FileCode2;
  const selectedIsScript = selectedFile?.path.startsWith('scripts/');
  const selectedIsExecutable = Boolean(selectedIsScript && selectedFile?.content.startsWith('#!'));
  const executionActive = execution?.status === 'queued' || execution?.status === 'running' || execution?.status === 'cancelling';
  const canRun = Boolean(skill && selectedIsExecutable && saveState === 'saved' && !launching && !executionActive);

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <WorkspaceChrome
          crumbs={[{ label: tWorkspace('nav.capabilities'), to: '/capabilities' }, { label: isNew ? t('editor.new') : skill?.name ?? t('editor.fallback') }]}
        status={editable ? <SaveIndicator state={saveState} /> : <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground"><LockKeyhole className="size-3.5" aria-hidden="true" />{t('editor.readOnly')}</span>}
        actions={editable ? <div className="flex items-center gap-2">{!isNew ? <Button type="button" variant="ghost" size="icon-compact" aria-label={t('delete.action', { name: skill?.name ?? name })} title={t('delete.action', { name: skill?.name ?? name })} onClick={() => { setDeleteError(''); setDeleteOpen(true); }}><Trash2 className="size-4" /></Button> : null}<Button size="compact" onClick={() => void save()} disabled={saveState === 'saving'}>{saveState === 'saving' ? <LoaderCircle className="size-4 motion-safe:animate-spin" /> : <Save className="size-4" />}{isNew ? t('editor.create') : t('common:actions.save')}</Button></div> : null}
      />

      <aside className="max-h-72 w-full shrink-0 overflow-auto border-b border-border bg-surface p-4 md:max-h-none md:w-72 md:border-b-0 md:border-r">
        {editable ? (
          <div>
            <label htmlFor="skill-name" className="text-xs font-medium text-muted-foreground">{t('editor.name')}</label>
            <Input id="skill-name" className="mt-2" value={name} onChange={(event) => { setName(event.target.value); setNameError(''); markUnsaved(); }} aria-invalid={Boolean(nameError)} />
            {nameError ? <p className="mt-1.5 text-xs text-danger" role="alert">{nameError}</p> : null}
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <CapabilityIcon className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
            <div className="min-w-0"><p className="truncate text-sm font-semibold">{skill?.name}</p><p className="mt-1 text-xs text-muted-foreground">{isLocal ? t('editor.localReadOnly') : t('editor.builtInReadOnly')}</p></div>
          </div>
        )}

        <div className={cn('mt-5', isBuiltIn && 'border-t border-border pt-4')}>
          <div className="flex min-h-8 items-center justify-between gap-2 px-1">
            <p className="text-xs font-medium text-muted-foreground">{t('editor.package')}</p>
            {editable ? (
              <Button variant="ghost" size="icon-compact" type="button" aria-label={t('editor.addFile')} title={t('editor.addFile')} onClick={() => { setAddingFile(true); setPathError(''); }}>
                <FilePlus2 className="size-4" />
              </Button>
            ) : null}
          </div>
          {addingFile ? (
            <form className="mt-2 space-y-2 border-y border-border py-3" onSubmit={addFile}>
              <label htmlFor="skill-file-path" className="text-xs font-medium text-muted-foreground">{t('editor.filePath')}</label>
              <div className="flex gap-1.5">
                <Input id="skill-file-path" className="h-8 font-mono text-xs" value={newFilePath} onChange={(event) => { setNewFilePath(event.target.value); setPathError(''); }} aria-invalid={Boolean(pathError)} />
                <Button type="submit" size="icon-compact" aria-label={t('editor.addFile')} title={t('editor.addFile')}><FilePlus2 className="size-4" /></Button>
                <Button type="button" variant="ghost" size="icon-compact" aria-label={t('common:actions.cancel')} title={t('common:actions.cancel')} onClick={() => { setAddingFile(false); setPathError(''); }}><X className="size-4" /></Button>
              </div>
              {pathError ? <p className="text-xs text-danger" role="alert">{pathError}</p> : <p className="text-xs text-muted-foreground">{t('editor.filePathHint')}</p>}
            </form>
          ) : null}
          <PackageTree groups={packageGroups} selectedPath={selectedFile?.path} onSelect={setSelectedPath} />
        </div>

        {isBuiltIn || isLocal ? (
          <div className="mt-5 border-t border-border pt-4">
            <div className="flex flex-wrap gap-2">
              <Badge variant="neutral">{isLocal ? t('source.local') : t('source.built-in')}</Badge>
              {isLocal && skill?.version ? <Badge variant="neutral">{skill.version}</Badge> : null}
            </div>
            {isBuiltIn ? (
              <p className={cn('mt-3 text-xs leading-5', isTerminalCommand ? 'text-warning' : 'text-muted-foreground')}>{isTerminalCommand ? t('terminal.warning') : t('platform.boundary')}</p>
            ) : null}
            {isLocal ? (
              <div className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
                <p>{t('editor.localReadOnly')}</p>
                {skill?.description ? <p>{skill.description}</p> : null}
                {Array.isArray(skill?.metadata?.bins) ? <p>{t('editor.localBins', { bins: (skill.metadata.bins as string[]).join(', ') })}</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <header className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4">
          <span className="truncate font-mono text-xs text-muted-foreground">{selectedFile?.path ?? 'SKILL.md'}</span>
          <span className="flex items-center gap-2">
            {selectedIsScript ? <Badge variant={selectedFile.content.startsWith('#!') ? 'success' : 'warning'}>{selectedFile.content.startsWith('#!') ? t('editor.executable') : t('editor.missingShebang')}</Badge> : null}
            {selectedIsScript && !isNew ? (
              <Button type="button" size="compact" disabled={!canRun} onClick={() => void runSelectedScript()} title={saveState !== 'saved' ? t('editor.run.saveFirst') : undefined}>
                {launching ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
                {t('editor.run.action')}
              </Button>
            ) : null}
            {editable && selectedFile?.path !== 'SKILL.md' ? <Button type="button" variant="ghost" size="icon-compact" aria-label={t('editor.deleteFile')} title={t('editor.deleteFile')} onClick={deleteSelectedFile}><Trash2 className="size-4" /></Button> : null}
            {isBuiltIn ? <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><LockKeyhole className="size-3.5" aria-hidden="true" />{t('editor.readOnly')}</span> : null}
          </span>
        </header>
        {selectedIsScript ? (
          <div className="shrink-0 border-b border-warning/30 bg-warning/5 px-4 py-2.5">
            <p className="text-xs text-warning">{t('editor.scriptWarning')}</p>
            {!isNew ? (
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
                {saveState !== 'saved' ? <p className="pt-6 text-xs text-warning">{t('editor.run.saveFirst')}</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <textarea
          className={cn('min-h-80 flex-1 resize-none border-0 bg-background p-4 font-mono text-[13px] leading-6 text-foreground disabled:cursor-default disabled:opacity-100', surfaceInteraction, focusRingInset)}
          value={selectedFile?.content ?? ''}
          onChange={(event) => { if (!selectedFile || !editable) return; setFiles((current) => current.map((file) => file.path === selectedFile.path ? { ...file, content: event.target.value } : file)); markUnsaved(); }}
          readOnly={!editable}
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
        {saveError ? <p className="shrink-0 border-t border-danger/30 bg-danger/5 px-4 py-3 text-[13px] text-danger" role="alert">{saveError}</p> : null}
      </main>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(nextOpen) => { setDeleteOpen(nextOpen); if (!nextOpen) setDeleteError(''); }}
        title={t('delete.title', { name: skill?.name ?? name })}
        description={t('delete.description')}
        confirmLabel={t('delete.action', { name: skill?.name ?? name })}
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

function isValidNewPath(path: string): boolean {
  const segments = path.split('/');
  return path.length <= 240 && (path.startsWith('scripts/') || path.startsWith('references/')) && !path.includes('\\') && segments.every((segment) => Boolean(segment) && segment !== '.' && segment !== '..');
}

function executionBadgeStatus(status: CommandExecutionStatus): 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' {
  if (status === 'succeeded') return 'completed';
  if (status === 'cancelling') return 'running';
  return status;
}

function isTerminalExecution(status: CommandExecutionStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function ResourceState({ icon: Icon, message, animated, error }: { icon: typeof LoaderCircle; message: string; animated?: boolean; error?: boolean }) {
  return <div className="flex h-full items-center justify-center p-6" role={error ? 'alert' : 'status'}><p className={cn('flex items-center gap-2 text-sm', error ? 'text-danger' : 'text-muted-foreground')}><Icon className={cn('size-4', animated && 'motion-safe:animate-spin')} aria-hidden="true" />{message}</p></div>;
}
