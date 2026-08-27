import { Link, useRouterState } from '@tanstack/react-router';
import { ArrowUp, Ban, ChevronDown, ChevronRight, Download, FileCode2, History, LoaderCircle, MessageSquareText, Plus, ShieldAlert, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentExecutionView, AgentToolCallView } from '@worklite/contracts';
import { api } from '@/api/client';
import { useAgentQuery } from '@/api/queries';
import { StreamingMarkdown } from '@/components/ai/streaming-markdown';
import { useLocale } from '@/components/locale-provider';
import { useTheme } from '@/components/theme-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { queryClient } from '@/lib/query-client';
import { cn } from '@/lib/utils';

const SYSTEM_HELPER_CHAT_ID = 'agt_system_helper_chat';
const HISTORY_LIMIT = 20;

type ArchivedExecution = { id: string; label: string; archivedAt: string };
type StoredExecutionState = { activeId: string | null; archived: ArchivedExecution[] };
type SlashCommand = '/log' | '/new' | '/resume';

const SLASH_COMMANDS: Array<{ value: SlashCommand; icon: typeof Download; descriptionKey: 'commands.logDescription' | 'commands.newDescription' | 'commands.resumeDescription' }> = [
  { value: '/log', icon: Download, descriptionKey: 'commands.logDescription' },
  { value: '/new', icon: Plus, descriptionKey: 'commands.newDescription' },
  { value: '/resume', icon: History, descriptionKey: 'commands.resumeDescription' },
];

function storageKey(workspaceSlug: string) {
  return `worklite.system-helper.executions.${workspaceSlug}`;
}

function readStoredState(workspaceSlug: string): StoredExecutionState {
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey(workspaceSlug)) ?? 'null') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { activeId: null, archived: [] };
    const record = value as Record<string, unknown>;
    const activeId = typeof record.activeId === 'string' ? record.activeId : null;
    const archived = Array.isArray(record.archived)
      ? record.archived.flatMap((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
          const entry = item as Record<string, unknown>;
          return typeof entry.id === 'string' && typeof entry.label === 'string' && typeof entry.archivedAt === 'string'
            ? [{ id: entry.id, label: entry.label, archivedAt: entry.archivedAt }]
            : [];
        }).slice(0, HISTORY_LIMIT)
      : [];
    return { activeId, archived };
  } catch {
    return { activeId: null, archived: [] };
  }
}

function AgentChat({ workspaceSlug }: { workspaceSlug: string }) {
  const { t } = useTranslation(['assistant', 'common']);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const agentQuery = useAgentQuery(workspaceSlug, SYSTEM_HELPER_CHAT_ID);
  const { applyAppearancePreference } = useTheme();
  const { applyLocalePreference } = useLocale();
  const initialState = useMemo(() => readStoredState(workspaceSlug), [workspaceSlug]);
  const [activeId, setActiveId] = useState<string | null>(initialState.activeId);
  const [archived, setArchived] = useState<ArchivedExecution[]>(initialState.archived);
  const [execution, setExecution] = useState<AgentExecutionView | null>(null);
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingExecution, setLoadingExecution] = useState(Boolean(initialState.activeId));
  const [error, setError] = useState('');
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentPathRef = useRef(pathname);
  const appliedResultIdsRef = useRef(new Set<string>());
  const isConfigured = Boolean(agentQuery.data?.providerId && agentQuery.data?.model);
  const running = execution?.status === 'running';
  const blocked = busy || running;
  const slashQuery = draft.trimStart().toLowerCase();
  const commandMatches = !running && slashQuery.startsWith('/') && !slashDismissed ? SLASH_COMMANDS.filter((command) => command.value.startsWith(slashQuery)) : [];

  useEffect(() => {
    window.localStorage.setItem(storageKey(workspaceSlug), JSON.stringify({ activeId, archived } satisfies StoredExecutionState));
  }, [activeId, archived, workspaceSlug]);

  useEffect(() => {
    if (currentPathRef.current !== pathname) {
      currentPathRef.current = pathname;
      setOpen(false);
    }
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;
    appliedResultIdsRef.current.clear();
    if (!activeId) {
      setExecution(null);
      setLoadingExecution(false);
      return;
    }
    setLoadingExecution(true);
    api.agentExecution(workspaceSlug, SYSTEM_HELPER_CHAT_ID, activeId)
      .then((next) => {
        if (cancelled) return;
        for (const call of next.toolCalls) if (call.status === 'completed') appliedResultIdsRef.current.add(call.id);
        setExecution(next);
      })
      .catch(() => { if (!cancelled) setError(t('assistant:execution.loadFailed')); })
      .finally(() => { if (!cancelled) setLoadingExecution(false); });
    return () => { cancelled = true; };
  }, [activeId, t, workspaceSlug]);

  useEffect(() => {
    if (!activeId || execution?.status !== 'running' || busy) return;
    const timer = window.setInterval(() => {
      void api.agentExecution(workspaceSlug, SYSTEM_HELPER_CHAT_ID, activeId).then((next) => {
        setExecution(next);
        void applyCompletedResults(next);
      }).catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [activeId, busy, execution?.status, workspaceSlug]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [execution, historyOpen, open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || blocked || !isConfigured) return;
    const command = message.toLowerCase();
    if (command === '/log' || command === '/new' || command === '/resume') {
      runCommand(command);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next = activeId
        ? await api.continueAgentExecution(workspaceSlug, SYSTEM_HELPER_CHAT_ID, activeId, message)
        : await api.createAgentExecution(workspaceSlug, SYSTEM_HELPER_CHAT_ID, message);
      setActiveId(next.id);
      setExecution(next);
      void applyCompletedResults(next);
      setDraft('');
      setHistoryOpen(false);
      setOpen(true);
    } catch {
      setError(t('assistant:execution.requestFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function cancelExecution() {
    if (!execution || execution.status !== 'running' || busy) return;
    setBusy(true);
    setError('');
    try {
      setExecution(await api.cancelAgentExecution(workspaceSlug, SYSTEM_HELPER_CHAT_ID, execution.id));
    } catch {
      setError(t('assistant:execution.cancelFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function applyCompletedResults(next: AgentExecutionView) {
    for (const call of next.toolCalls) {
      if (call.status !== 'completed' || appliedResultIdsRef.current.has(call.id)) continue;
      appliedResultIdsRef.current.add(call.id);
      await applyCompletedResult(call);
    }
  }

  async function applyCompletedResult(call: AgentToolCallView) {
    const result = call.result;
    if (!result) return;
    if (result.type === 'resource') {
      const queryKey = result.resourceType === 'provider' ? 'model-providers' : result.resourceType === 'mcp-server' ? 'mcp-servers' : `${result.resourceType}s`;
      await queryClient.invalidateQueries({ queryKey: [queryKey] });
      return;
    }
    if (result.type === 'settings') {
      const saved = await api.settings();
      queryClient.setQueryData(['settings'], saved);
      applyAppearancePreference(saved.appearance);
      applyLocalePreference(saved.locale);
      return;
    }
    if (result.type === 'navigation') window.location.assign(result.route);
  }

  function archiveCurrent() {
    if (!execution) return;
    const label = execution.messages.find((message) => message.role === 'user')?.content || t('assistant:history.untitled');
    setArchived((current) => [{ id: execution.id, label, archivedAt: new Date().toISOString() }, ...current.filter((item) => item.id !== execution.id)].slice(0, HISTORY_LIMIT));
  }

  function runCommand(command: SlashCommand) {
    setDraft('');
    setSlashDismissed(true);
    setOpen(true);
    if (command === '/log') {
      downloadExecutionLog(execution, {
        title: t('assistant:log.title'),
        generated: t('assistant:log.generated'),
        empty: t('assistant:log.empty'),
        user: t('assistant:log.user'),
        assistant: t('assistant:log.assistant'),
        tool: t('assistant:log.tool'),
      });
      return;
    }
    if (command === '/new') {
      archiveCurrent();
      setActiveId(null);
      setExecution(null);
      setHistoryOpen(false);
      setError('');
      return;
    }
    setHistoryOpen(true);
  }

  function resume(item: ArchivedExecution) {
    if (execution && execution.id !== item.id) archiveCurrent();
    setActiveId(item.id);
    setArchived((current) => current.filter((entry) => entry.id !== item.id));
    setHistoryOpen(false);
    setError('');
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (running && event.key === 'Enter') {
      event.preventDefault();
      return;
    }
    if (commandMatches.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      setActiveCommandIndex((current) => (current + offset + commandMatches.length) % commandMatches.length);
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const command = commandMatches[activeCommandIndex] ?? commandMatches[0];
      if (command) runCommand(command.value);
    } else if (event.key === 'Escape') {
      setSlashDismissed(true);
    }
  }

  const events = execution ? [
    ...execution.messages.map((item) => ({ kind: 'message' as const, occurredAt: item.createdAt, item })),
    ...execution.toolCalls.map((item) => ({ kind: 'tool' as const, occurredAt: item.createdAt, item })),
  ].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)) : [];

  const status = busy ? t('assistant:status.running')
    : execution?.status === 'failed' ? t('assistant:status.failed')
      : execution?.status === 'cancelled' ? t('assistant:status.cancelled')
      : execution?.status === 'completed' ? t('assistant:status.completed')
        : execution?.status === 'running' ? t('assistant:status.running') : '';

  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 z-30 sm:inset-x-6 sm:bottom-6">
      <div className="pointer-events-auto mx-auto flex w-full max-w-[1200px] flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-md">
        <div id="assistant-panel-content" aria-hidden={!open} inert={!open} className={cn('overflow-hidden transition-[height,opacity,transform] duration-200 motion-reduce:transition-none', open ? 'h-[min(680px,calc(100vh-96px))] translate-y-0 opacity-100 max-md:h-[min(70vh,680px)]' : 'pointer-events-none h-0 translate-y-2 opacity-0')}>
          <section className="flex h-full min-h-0 flex-col" aria-labelledby="assistant-panel-title">
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="assistant-panel-title" className="text-base font-semibold">{t('assistant:title')}</h2>
                  {status ? <Badge variant={execution?.status === 'failed' ? 'danger' : 'neutral'}>{status}</Badge> : null}
                </div>
                <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{t('assistant:description')}</p>
              </div>
              <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-compact" aria-label={t('assistant:minimized.minimize')} onClick={() => setOpen(false)}><ChevronDown className="size-4" /></Button></TooltipTrigger><TooltipContent>{t('assistant:minimized.minimize')}</TooltipContent></Tooltip>
            </header>

            {historyOpen ? (
              <HistoryPane archived={archived} loading={loadingExecution} onResume={resume} onRemove={(id) => setArchived((current) => current.filter((item) => item.id !== id))} />
            ) : (
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4">
                <div className="flex min-h-full flex-col py-5">
                  {events.length === 0 && !loadingExecution ? <StarterPane onSelect={(prompt) => { setDraft(prompt); setOpen(true); }} /> : null}
                  {loadingExecution ? <p className="m-auto flex items-center gap-2 text-sm text-muted-foreground" role="status"><LoaderCircle className="size-4 motion-safe:animate-spin" />{t('assistant:execution.loading')}</p> : null}
                  {events.map((event) => event.kind === 'message' ? <MessageRow key={event.item.id} message={event.item} /> : <ToolCallPanel key={event.item.id} call={event.item} />)}
                  {running ? <WorkingRow /> : null}
                  {execution?.error ? <p className="mt-4 border-l-2 border-danger pl-3 text-[13px] text-danger" role="alert">{execution.error}</p> : null}
                  {error ? <p className="mt-4 border-l-2 border-danger pl-3 text-[13px] text-danger" role="alert">{error}</p> : null}
                </div>
              </div>
            )}
          </section>
        </div>

        {!open && status ? <button type="button" className="flex min-h-8 items-center gap-2 border-b border-border px-3 text-left text-[13px] text-muted-foreground hover:bg-surface-subtle" onClick={() => setOpen(true)}><MessageSquareText className="size-4 shrink-0 text-brand" /><span className="min-w-0 flex-1 truncate">{status}</span><ChevronRight className="size-4" /></button> : null}

        {agentQuery.isLoading ? (
          <div className="flex min-h-12 items-center gap-2 px-3 text-[13px] text-muted-foreground" role="status"><LoaderCircle className="size-4 motion-safe:animate-spin" />{t('assistant:composer.loading')}</div>
        ) : isConfigured ? (
          <form className="flex items-center gap-2 p-2" autoComplete="off" onSubmit={submit}>
            <label htmlFor="assistant-message" className="sr-only">{t('assistant:composer.label')}</label>
            <Popover open={commandMatches.length > 0} onOpenChange={(next) => !next && setSlashDismissed(true)}>
              <PopoverAnchor asChild><div className="min-w-0 flex-1"><Input id="assistant-message" name="system-helper-message" autoComplete="off" value={draft} onChange={(event) => { setDraft(event.target.value); setSlashDismissed(false); setActiveCommandIndex(0); }} onFocus={() => setOpen(true)} onKeyDown={handleComposerKeyDown} placeholder={t('assistant:composer.placeholder')} role="combobox" aria-expanded={commandMatches.length > 0} /></div></PopoverAnchor>
              <PopoverContent side="top" align="start" className="w-[min(420px,calc(100vw-24px))] p-1" onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()}>
                <div role="listbox" aria-label={t('assistant:commands.menuLabel')}>{commandMatches.map((command, index) => { const Icon = command.icon; return <button key={command.value} type="button" role="option" aria-selected={index === activeCommandIndex} className={cn('flex w-full items-start gap-3 rounded-md px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring', index === activeCommandIndex ? 'bg-brand-subtle' : 'hover:bg-surface-subtle')} onPointerDown={(event) => event.preventDefault()} onPointerMove={() => setActiveCommandIndex(index)} onClick={() => runCommand(command.value)}><Icon className="mt-0.5 size-4 shrink-0 text-brand" /><span><span className="block font-mono text-[13px] font-medium">{command.value}</span><span className="mt-0.5 block text-xs text-muted-foreground">{t(`assistant:${command.descriptionKey}`)}</span></span></button>; })}</div>
              </PopoverContent>
            </Popover>
            <Tooltip><TooltipTrigger asChild><Button type={running ? 'button' : 'submit'} variant={running ? 'secondary' : 'primary'} size="icon-compact" aria-label={running ? t('assistant:composer.stop') : t('assistant:composer.send')} disabled={running ? busy : !draft.trim() || busy} onClick={running ? () => void cancelExecution() : undefined}>{running ? <Square className="size-3.5 fill-current" /> : busy ? <LoaderCircle className="size-4 motion-safe:animate-spin" /> : <ArrowUp className="size-4" />}</Button></TooltipTrigger><TooltipContent>{running ? t('assistant:composer.stop') : t('assistant:composer.send')}</TooltipContent></Tooltip>
          </form>
        ) : (
          <Link to="/agents/$agentId" params={{ agentId: SYSTEM_HELPER_CHAT_ID }} className="flex min-h-12 items-center gap-2 px-3 text-[13px] font-medium hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"><ShieldAlert className="size-4 shrink-0 text-brand" /><span className="min-w-0 flex-1">{t('assistant:composer.configure')}</span><ChevronRight className="size-4 text-muted-foreground" /></Link>
        )}
      </div>
    </div>
  );
}

function StarterPane({ onSelect }: { onSelect: (prompt: string) => void }) {
  const { t } = useTranslation('assistant');
  const starters = ['provider', 'skill', 'mcp', 'agent'] as const;
  return <div className="my-auto py-6"><div className="mb-5 flex items-center gap-3"><span className="flex size-9 items-center justify-center rounded-md border border-border bg-surface"><MessageSquareText className="size-[18px] text-brand" /></span><div><p className="text-sm font-semibold">{t('starters.title')}</p><p className="mt-0.5 text-[13px] text-muted-foreground">{t('messages.welcome')}</p></div></div><div className="grid gap-2 sm:grid-cols-2">{starters.map((starter) => <button key={starter} type="button" className="min-h-[72px] rounded-md border border-border bg-surface p-3 text-left hover:bg-surface-subtle" onClick={() => onSelect(t(`starters.${starter}.prompt`))}><span className="block text-sm font-medium">{t(`starters.${starter}.title`)}</span><span className="mt-1 block text-[13px] leading-5 text-muted-foreground">{t(`starters.${starter}.description`)}</span></button>)}</div></div>;
}

function MessageRow({ message }: { message: AgentExecutionView['messages'][number] }) {
  const { t } = useTranslation('assistant');
  if (message.role === 'user') return <article className="flex justify-end py-3" aria-label={t('speaker.you')}><div className="max-w-[min(78%,640px)] rounded-md bg-surface-subtle px-3 py-2.5"><p className="whitespace-pre-wrap break-words text-sm leading-6">{message.content}</p></div></article>;
  return <article className="flex items-start gap-3 py-4" aria-label={t('speaker.assistant')}><span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface"><MessageSquareText className="size-4 text-brand" /></span><div className="min-w-0 flex-1 pt-0.5"><StreamingMarkdown content={message.content} /></div></article>;
}

function WorkingRow() {
  const { t } = useTranslation('assistant');
  return <div className="flex items-center gap-3 py-4 text-[13px] text-muted-foreground" role="status"><span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface"><LoaderCircle className="size-4 text-brand motion-safe:animate-spin" /></span><span>{t('execution.working')}</span></div>;
}

function ToolCallPanel({ call }: { call: AgentToolCallView }) {
  const { t } = useTranslation('assistant');
  const [expanded, setExpanded] = useState(false);
  const finished = call.status === 'completed' || call.status === 'failed' || call.status === 'cancelled';
  const resource = call.result?.type === 'resource' ? call.result : null;
  const scriptName = call.scriptPath?.split('/').pop() || t('tool.script');
  const variant = call.status === 'completed' ? 'success' : call.status === 'running' ? 'brand' : call.status === 'cancelled' ? 'neutral' : 'danger';
  return <article className="my-2 border-l-2 border-warning bg-surface-subtle" aria-label={t('tool.label')}>
    <button type="button" className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left outline-none hover:bg-background/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" aria-expanded={expanded} aria-label={expanded ? t('tool.collapse') : t('tool.expand')} onClick={() => setExpanded((value) => !value)}>
      <FileCode2 className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{call.skillName || t('tool.label')} <span className="font-mono text-xs font-normal text-muted-foreground">/ {scriptName}</span></span>
      {finished && call.exitCode !== null ? <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{t('tool.exitCode', { code: call.exitCode })}</span> : null}
      <Badge variant={variant}>{t(`tool.status.${call.status}`)}</Badge>
      {expanded ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
    </button>
    {expanded ? <div className="border-t border-border px-3 pb-3 pt-2.5">
      <dl className="grid gap-3 text-xs sm:grid-cols-2"><div><dt className="font-medium text-muted-foreground">{t('tool.script')}</dt><dd className="mt-1 break-all font-mono">{call.scriptPath}</dd></div><div><dt className="font-medium text-muted-foreground">{t('tool.workingDirectory')}</dt><dd className="mt-1 break-all font-mono">{call.workingDirectory}</dd></div><div className="sm:col-span-2"><dt className="font-medium text-muted-foreground">{t('tool.arguments')}</dt><dd><pre className="mt-1 overflow-x-auto rounded-md border border-border bg-background p-2.5 font-mono"><code>{JSON.stringify(call.arguments)}</code></pre></dd></div></dl>
      <p className="mt-3 flex items-start gap-2 text-[13px] text-warning"><ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{t('tool.warning')}</p>
      {finished ? <div className="mt-3"><p className="text-xs font-medium text-muted-foreground">{t('tool.output', { code: call.exitCode ?? t('tool.noExitCode') })}</p><pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border bg-background p-2.5 font-mono text-xs"><code>{call.output || t('tool.noOutput')}</code></pre></div> : null}
      {resource ? <Button asChild type="button" variant="link" size="sm" className="mt-2 h-auto px-0"><a href={resource.route}>{resource.resourceType === 'provider' ? t('tool.openSecureProvider') : t('tool.openResource')}<ChevronRight className="size-3.5" /></a></Button> : null}
    </div> : null}
  </article>;
}

function HistoryPane({ archived, loading, onResume, onRemove }: { archived: ArchivedExecution[]; loading: boolean; onResume: (item: ArchivedExecution) => void; onRemove: (id: string) => void }) {
  const { t } = useTranslation('assistant');
  return <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5"><div className="flex items-center gap-3 border-b border-border pb-4"><span className="flex size-9 items-center justify-center rounded-md border border-border bg-surface"><History className="size-[18px] text-brand" /></span><div><p className="text-sm font-semibold">{t('history.title')}</p><p className="mt-0.5 text-[13px] text-muted-foreground">{t('history.description')}</p></div></div>{loading ? <p className="py-8 text-center text-sm text-muted-foreground">{t('execution.loading')}</p> : archived.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">{t('history.empty')}</p> : <div className="divide-y divide-border">{archived.map((item) => <div key={item.id} className="flex items-center gap-3 py-3"><button type="button" className="min-w-0 flex-1 text-left hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onResume(item)}><span className="block truncate text-sm font-medium">{item.label}</span><span className="mt-1 block text-xs text-muted-foreground">{new Date(item.archivedAt).toLocaleString()}</span></button><Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-compact" aria-label={t('history.remove')} onClick={() => onRemove(item.id)}><Ban className="size-4" /></Button></TooltipTrigger><TooltipContent>{t('history.remove')}</TooltipContent></Tooltip></div>)}</div>}</div>;
}

function downloadExecutionLog(execution: AgentExecutionView | null, labels: { title: string; generated: string; empty: string; user: string; assistant: string; tool: string }) {
  const lines = [`# ${labels.title}`, '', `${labels.generated}: ${new Date().toISOString()}`, ''];
  if (!execution) lines.push(labels.empty);
  else {
    const events = [
      ...execution.messages.map((item) => ({ at: item.createdAt, text: `## ${item.role === 'user' ? labels.user : labels.assistant}\n\n${item.content}` })),
      ...execution.toolCalls.map((call) => ({ at: call.createdAt, text: `## ${labels.tool}: ${call.skillName ?? 'Skill'} / ${call.scriptPath ?? ''}\n\nArguments: \`${JSON.stringify(call.arguments)}\`\n\nStatus: ${call.status}\n\n\`\`\`text\n${call.output}\n\`\`\`` })),
    ].sort((left, right) => left.at.localeCompare(right.at));
    lines.push(...events.flatMap((event) => [event.text, '']));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `worklite-system-helper-${new Date().toISOString().replaceAll(':', '-')}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export { AgentChat };
