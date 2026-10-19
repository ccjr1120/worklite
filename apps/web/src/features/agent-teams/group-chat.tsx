import { Fragment, useEffect, useMemo, useRef, useState, type CompositionEvent as ReactCompositionEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowUp, ArrowUpRight, AtSign, FolderPlus, LoaderCircle, MessageCircleQuestion, Pause, Play, RefreshCw, RotateCcw, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentTeamGroupView, AgentTeamRoleId } from '@worklite/contracts';
import { ApiError, api } from '@/api/client';
import { agentTeamGroupQueryKey, agentTeamGroupsQueryKey, agentTeamQueryKey, useAgentTeamGroupQuery, useAgentTeamQuery } from '@/api/queries';
import { Conversation, ConversationContent } from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { PromptInput, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { focusRingInset } from '@/components/ui/interaction';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { cn } from '@/lib/utils';

const ROLE_ORDER: AgentTeamRoleId[] = ['planner', 'test_designer', 'developer', 'test_author', 'test_runner', 'reviewer', 'worktree-manager', 'team-manager'];
const ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting_for_input', 'paused'];
// Unsettled and failed Runs appear as cards inside the transcript; settled Runs leave
// only their messages and evidence behind.
const CARD_RUN_STATUSES = [...ACTIVE_RUN_STATUSES, 'failed'];
const COMPOSITION_ENTER_GUARD_MS = 30;

type GroupView = AgentTeamGroupView;
type GroupRun = GroupView['runs'][number];
type GroupMessage = GroupView['messages'][number];
type GroupPendingInput = GroupRun['pendingInputs'][number];

export function AgentTeamGroupChatPage({ groupId }: { groupId: string }) {
  const { t } = useTranslation('agentTeams');
  const queryClient = useQueryClient();
  const groupQuery = useAgentTeamGroupQuery(groupId);
  const teamQuery = useAgentTeamQuery('personal', groupQuery.data?.teamId ?? '');
  const [recipientToken, setRecipientToken] = useState<AgentTeamRoleId | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [controlKey, setControlKey] = useState('');
  const [error, setError] = useState('');
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [activeValue, setActiveValue] = useState('');
  const [directoryDialogOpen, setDirectoryDialogOpen] = useState(false);
  const imeCompositionRef = useRef({ active: false, endedAt: 0 });

  useEffect(() => {
    if (!groupId) return;
    const events = new EventSource(api.agentTeamGroupEventsUrl(groupId), { withCredentials: true });
    events.onmessage = () => {
      void queryClient.invalidateQueries({ queryKey: agentTeamGroupQueryKey(groupId) });
      void queryClient.invalidateQueries({ queryKey: agentTeamGroupsQueryKey(groupQuery.data?.teamId ?? '') });
      void queryClient.invalidateQueries({ queryKey: agentTeamQueryKey(groupQuery.data?.teamId ?? '') });
    };
    return () => events.close();
  }, [groupId, groupQuery.data?.teamId, queryClient]);

  const roles = useMemo(() => teamQuery.data?.roles.map((role) => role.role) ?? ROLE_ORDER, [teamQuery.data?.roles]);
  const roleName = (role: string) => {
    const configured = teamQuery.data?.roles.find((item) => item.role === role);
    return configured?.displayName ?? (ROLE_ORDER.includes(role) ? t(`role.${roleTranslationKey(role)}`) : role);
  };
  const mentionMatch = /(?:^|\s)@([^\s@]*)$/.exec(draft);
  const mentionQuery = mentionMatch?.[1]?.toLocaleLowerCase() ?? '';
  const mentionMatches = mentionMatch && !mentionDismissed
    ? roles.filter((role) => role.toLowerCase().replaceAll('-', '_').includes(mentionQuery.replaceAll('-', '_')) || roleName(role).toLocaleLowerCase().includes(mentionQuery))
    : [];
  const mentionMenuOpen = Boolean(mentionMatch && !mentionDismissed);

  function selectRole(role: AgentTeamRoleId) {
    const atIndex = draft.lastIndexOf('@');
    setDraft(atIndex >= 0 ? draft.slice(0, atIndex) : draft);
    setRecipientToken(role);
    setMentionDismissed(true);
  }

  function handleCompositionStart() {
    imeCompositionRef.current.active = true;
  }

  function handleCompositionEnd(event: ReactCompositionEvent<HTMLTextAreaElement>) {
    imeCompositionRef.current.active = false;
    imeCompositionRef.current.endedAt = event.timeStamp;
  }

  function isImeComposing(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
    if (event.nativeEvent.isComposing || imeCompositionRef.current.active) return true;
    return event.timeStamp - imeCompositionRef.current.endedAt < COMPOSITION_ENTER_GUARD_MS;
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape') {
      if (mentionMenuOpen) {
        event.preventDefault();
        setMentionDismissed(true);
      }
      return;
    }
    if (recipientToken && !draft && event.key === 'Backspace') {
      setRecipientToken(null);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      if (isImeComposing(event)) return;
      event.preventDefault();
      if (mentionMenuOpen) {
        const role = mentionMatches.find((item) => `role:${item}` === activeValue) ?? mentionMatches[0];
        if (role) selectRole(role);
        return;
      }
      event.currentTarget.form?.requestSubmit();
      return;
    }
    if (!(event.key === 'ArrowDown' || event.key === 'ArrowUp') || !mentionMenuOpen) return;
    const values = mentionMatches.map((role) => `role:${role}`);
    if (!values.length) return;
    event.preventDefault();
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    const currentIndex = Math.max(0, values.indexOf(activeValue));
    setActiveValue(values[(currentIndex + offset + values.length) % values.length]!);
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError('');
    try {
      const roleControl = parseGroupRoleControl(body, roles);
      if (roleControl) {
        if (!groupQuery.data?.runs.length) throw new Error(t('group.noRoleTask'));
        const updated = await api.controlAgentTeamGroup(groupId, {
          operation: roleControl.operation,
          targetRole: roleControl.role,
          runIds: groupQuery.data.runs.map((run) => run.id),
        });
        queryClient.setQueryData(agentTeamGroupQueryKey(groupId), updated);
        void queryClient.invalidateQueries({ queryKey: agentTeamGroupsQueryKey(updated.teamId) });
        setDraft('');
        return;
      }
      const addressedMessage = parseGroupAddress(body, roles);
      const updated = await api.sendAgentTeamGroupMessage(groupId, {
        body: addressedMessage?.body ?? body,
        recipientRole: addressedMessage?.role ?? recipientToken ?? 'team-manager',
        submissionId: crypto.randomUUID(),
      });
      queryClient.setQueryData(agentTeamGroupQueryKey(groupId), updated);
      void queryClient.invalidateQueries({ queryKey: agentTeamGroupsQueryKey(updated.teamId) });
      setDraft('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('group.sendFailed'));
    } finally {
      setSending(false);
    }
  }

  async function control(operation: 'pause' | 'resume' | 'cancel' | 'retry' | 'reexecute', runIds: string[], targetRole?: AgentTeamRoleId) {
    const key = `${operation}:${runIds.join(',')}`;
    setControlKey(key);
    setError('');
    try {
      const updated = await api.controlAgentTeamGroup(groupId, { operation, runIds, targetRole });
      queryClient.setQueryData(agentTeamGroupQueryKey(groupId), updated);
      void queryClient.invalidateQueries({ queryKey: agentTeamGroupsQueryKey(updated.teamId) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('group.controlFailed'));
    } finally {
      setControlKey('');
    }
  }

  async function answerQuestion(run: GroupRun, pendingInput: GroupPendingInput, answer: string, commands: string[], directories: string[]) {
    const updated = await api.answerAgentTeamGroupRun(groupId, run.id, {
      pendingInputId: pendingInput.id,
      scopeRevision: pendingInput.scopeRevision,
      answer,
      authorizedCommands: commands,
      ...(directories.length ? { directories } : {}),
    });
    queryClient.setQueryData(agentTeamGroupQueryKey(groupId), updated);
    void queryClient.invalidateQueries({ queryKey: agentTeamGroupsQueryKey(updated.teamId) });
  }

  if (groupQuery.isLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <WorkspaceChrome crumbs={[{ label: t('title') }]} />
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-6"><Skeleton className="h-24 w-3/4 self-end rounded-2xl" /><Skeleton className="h-40 w-full rounded-2xl" /><Skeleton className="h-24 w-2/3 rounded-2xl" /></div>
      </div>
    );
  }
  const notFound = groupQuery.isError && groupQuery.error instanceof ApiError && groupQuery.error.status === 404;
  if (notFound || (!groupQuery.isError && !groupQuery.data)) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <WorkspaceChrome crumbs={[{ label: t('title') }]} />
        <div className="mx-auto w-full max-w-3xl px-4 py-6"><EmptyState title={t('group.unavailable.title')} description={t('group.unavailable.description')} /></div>
      </div>
    );
  }
  if (groupQuery.isError || !groupQuery.data) return <div className="flex h-full min-h-0 flex-col"><WorkspaceChrome crumbs={[{ label: t('title') }]} /><ErrorState title={t('group.loadFailed')} onAction={() => void groupQuery.refetch()} /></div>;

  const group = groupQuery.data;
  // An active question is represented only by its answer card; the persisted question
  // message becomes the quiet line again once the Run's pending input settles.
  const activeQuestions = new Set(group.runs.flatMap((run) => run.pendingInputs.map((pendingInput) => `${run.id}:${pendingInput.question}`)));
  const repositoryName = (id: string) => group.repositories.find((repository) => repository.id === id)?.name ?? id;

  // Run cards live in the transcript at the position of their Run's latest activity,
  // so the reader meets a status exactly where the work happened instead of scanning a
  // separate band above the composer.
  const failureReasonByRun = new Map<string, string>();
  const lastMessageIndexByRun = new Map<string, number>();
  group.messages.forEach((message, index) => {
    if (message.sender === 'system' && message.kind === 'status' && message.runId) {
      failureReasonByRun.set(message.runId, message.body);
    }
    if (message.runId) lastMessageIndexByRun.set(message.runId, index);
  });
  const cardsAfter = new Map<number, GroupRun[]>();
  const unanchoredRuns: GroupRun[] = [];
  for (const run of group.runs) {
    if (!CARD_RUN_STATUSES.includes(run.status)) continue;
    const index = lastMessageIndexByRun.get(run.id);
    if (index === undefined) unanchoredRuns.push(run);
    else cardsAfter.set(index, [...(cardsAfter.get(index) ?? []), run]);
  }
  const runCard = (run: GroupRun) => (
    <RunStatusCard
      key={run.id}
      run={run}
      roleName={roleName}
      failureReason={run.status === 'failed' ? failureReasonByRun.get(run.id) ?? '' : ''}
      controlKey={controlKey}
      onControl={(operation) => void control(operation, [run.id])}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceChrome crumbs={[{ label: t('title') }, { label: group.title || t('group.untitled') }]} actions={(
        <Link to="/agent-teams/$teamId" params={{ teamId: group.teamId }} className={cn('inline-flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground', focusRingInset)}>
          <ArrowLeft className="size-4" aria-hidden="true" />{t('group.backToRecords')}
        </Link>
      )} />
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('group.transcript')}>
        <Conversation className="min-h-0 flex-1 px-4 md:px-8" scrollToEndLabel={t('group.backToBottom')}>
          <ConversationContent className="mx-auto w-full max-w-3xl">
            {group.messages.length ? group.messages.map((message, index) => (
              <Fragment key={message.id}>
                <GroupMessageRow message={message} repositoryName={repositoryName} roleName={roleName} activeQuestion={message.kind === 'question' && activeQuestions.has(`${message.runId}:${message.body}`)} />
                {(cardsAfter.get(index) ?? []).map(runCard)}
              </Fragment>
            )) : (
              <div className="m-auto max-w-md py-12 text-center">
                <p className="font-medium text-foreground">{t('group.empty.title')}</p>
                <p className="mt-2 text-sm text-muted-foreground">{t('group.empty.description')}</p>
              </div>
            )}
            {unanchoredRuns.map(runCard)}
            {group.runs.flatMap((run) => run.pendingInputs.map((pendingInput) => (
              <QuestionCard
                key={pendingInput.id}
                run={run}
                pendingInput={pendingInput}
                onSubmit={async (answer, commands, directories) => {
                  await answerQuestion(run, pendingInput, answer, commands, directories);
                }}
              />
            )))}
            {error ? <p className="wl-enter mt-4 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2 text-[13px] text-danger" role="alert">{error}</p> : null}
          </ConversationContent>
        </Conversation>

        <PromptInput onSubmit={(event) => void submitMessage(event)} className="mx-auto max-w-3xl px-4 pb-4 pt-1 md:px-0">
          <label htmlFor="agent-team-group-message" className="sr-only">{t('group.recipient')}</label>
          <Popover open={mentionMenuOpen} onOpenChange={(next) => { if (!next) setMentionDismissed(true); }}>
            <PopoverAnchor asChild>
              {/* The composer is one floating card: recipient token, auto-growing text, and submit share it. */}
              <div className="flex min-w-0 flex-1 flex-wrap items-end gap-1.5 rounded-2xl border border-border bg-surface py-1.5 pl-2.5 pr-1.5 shadow-sm transition-[border-color,box-shadow] duration-[200ms] ease-[var(--ease-out)] focus-within:border-brand/60 focus-within:shadow-md focus-within:ring-[3px] focus-within:ring-ring/15">
                {recipientToken ? (
                  <span className="wl-enter mb-1.5 inline-flex h-7 max-w-[min(16rem,70%)] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-brand/30 bg-brand-subtle pl-2.5 pr-1.5 text-[13px] font-medium text-foreground">
                    <AtSign className="size-3.5 shrink-0 text-brand" aria-hidden="true" />
                    <span className="truncate">{roleName(recipientToken)}</span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" className={cn('wl-press rounded-full p-0.5 text-muted-foreground hover:bg-surface hover:text-foreground', focusRingInset)} aria-label={t('group.mention.remove')} onClick={() => setRecipientToken(null)}>
                          <X className="size-3.5" aria-hidden="true" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{t('group.mention.remove')}</TooltipContent>
                    </Tooltip>
                  </span>
                ) : null}
                <PromptInputTextarea
                  className="min-w-32 basis-40 border-0 bg-transparent px-1 shadow-none focus:border-transparent focus:ring-0"
                  id="agent-team-group-message"
                  name="group-message"
                  autoComplete="off"
                  value={draft}
                  onValueChange={(value) => { setDraft(value); setMentionDismissed(false); setActiveValue(''); }}
                  onKeyDown={handleComposerKeyDown}
                  onCompositionStart={handleCompositionStart}
                  onCompositionEnd={handleCompositionEnd}
                  placeholder={t('group.messagePlaceholder')}
                  role="combobox"
                  aria-expanded={mentionMenuOpen}
                  rows={1}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" aria-label={t('group.addRepository')} className={cn('wl-press mb-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-subtle hover:text-foreground', focusRingInset)} onClick={() => setDirectoryDialogOpen(true)}>
                      <FolderPlus className="size-4" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t('group.addRepository')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PromptInputSubmit
                      className={cn('wl-press ml-auto inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-brand bg-[image:var(--brand-gradient)] text-brand-foreground shadow-xs hover:bg-brand-hover hover:bg-none disabled:cursor-not-allowed disabled:opacity-40', focusRingInset)}
                      status={sending ? 'submitted' : 'idle'}
                      aria-label={t('group.send')}
                      aria-busy={sending}
                      disabled={!draft.trim() || sending}
                    >
                      {sending ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <ArrowUp className="size-4" aria-hidden="true" />}
                    </PromptInputSubmit>
                  </TooltipTrigger>
                  <TooltipContent>{sending ? t('group.sending') : t('group.send')}</TooltipContent>
                </Tooltip>
              </div>
            </PopoverAnchor>
            <PopoverContent
              side="top"
              align="start"
              matchTrigger
              className="p-0"
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              {/* The menu reuses the shared cmdk primitive; filtering follows the composer
                  text and keyboard focus never leaves the textarea. */}
              <Command shouldFilter={false} value={activeValue} onValueChange={setActiveValue} className="bg-transparent">
                <CommandList className="max-h-64" aria-label={t('group.mention.menuLabel')}>
                  <CommandEmpty>{t('group.mention.empty')}</CommandEmpty>
                  {mentionMatches.map((role) => (
                    <CommandItem key={role} value={`role:${role}`} onSelect={() => selectRole(role)}>
                      <AtSign className="size-4 shrink-0 text-brand" aria-hidden="true" />
                      <span className="truncate">{roleName(role)}</span>
                      <span className="ml-auto font-mono text-xs text-muted-foreground">{role}</span>
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </PromptInput>
      </section>
      <AddDirectoryDialog
        open={directoryDialogOpen}
        onOpenChange={setDirectoryDialogOpen}
        onAdd={async (directory) => {
          const updated = await api.addAgentTeamGroupRepositories(groupId, { repositories: [{ directory }] });
          queryClient.setQueryData(agentTeamGroupQueryKey(groupId), updated);
          void queryClient.invalidateQueries({ queryKey: agentTeamGroupsQueryKey(updated.teamId) });
        }}
      />
    </div>
  );
}

function GroupMessageRow({ message, repositoryName, roleName, activeQuestion }: { message: GroupMessage; repositoryName: (id: string) => string; roleName: (role: string) => string; activeQuestion?: boolean }) {
  const { t } = useTranslation('agentTeams');
  const repositories = message.repositoryIds.map(repositoryName);

  // Status entries are notes, not speakers: they carry no identity mark.
  if (message.sender === 'system') {
    return <p className="wl-fade mx-auto max-w-md py-1 text-center text-xs text-muted-foreground" role="status">{message.body}</p>;
  }

  // A still-open question is represented by its answer card at the end of the transcript.
  if (activeQuestion) return null;

  if (message.sender === 'user') {
    return (
      <Message from="user" aria-label={t('group.you')} className="wl-enter">
        <MessageContent className="max-w-[min(78%,640px)] rounded-2xl rounded-br-md bg-brand-subtle px-4 py-2.5">
          <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.body}</p>
        </MessageContent>
        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {message.recipientRole ? <span>@{roleName(message.recipientRole)}</span> : null}
          {repositories.map((name) => <span key={name}>{name}</span>)}
          {message.deliveryStatus === 'pending' ? <span className="inline-flex items-center gap-1.5" role="status"><span className="wl-live text-brand" aria-hidden="true" />{t('group.deliveryPending')}</span> : null}
          {message.deliveryStatus === 'failed' ? <span className="text-danger" role="alert">{t('group.deliveryFailed')}</span> : null}
          <time>{new Date(message.createdAt).toLocaleString()}</time>
        </div>
      </Message>
    );
  }

  const senderName = roleName(message.senderRole ?? 'team-manager');
  const handoffTarget = message.kind === 'handoff' && message.recipientRole ? roleName(message.recipientRole) : null;
  return (
    <Message from="assistant" aria-label={senderName} className="wl-enter">
      <div className="flex w-full items-start gap-3">
        <span className="mt-0.5 inline-flex h-7 shrink-0 items-center rounded-full border border-border bg-surface px-2 text-xs font-medium text-muted-foreground shadow-xs">@{senderName}</span>
        <MessageContent className="min-w-0 flex-1 pt-1">
          {handoffTarget ? <p className="mb-1 text-xs text-muted-foreground">@{senderName} → @{handoffTarget}</p> : null}
          {message.kind === 'question' ? (
            <p className="my-1 flex items-start gap-2 text-sm text-muted-foreground">
              <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 whitespace-pre-wrap break-words">{message.body}</span>
            </p>
          ) : (
            <MessageResponse content={message.body} />
          )}
          {message.fileReferences.length ? (
            <ul className="mt-3 flex flex-wrap gap-2">
              {message.fileReferences.map((file) => (
                <li key={`${file.documentId}-${file.revision}`}>
                  <Link to="/agent-team-runs/$runId" params={{ runId: message.runId ?? '' }} className={cn('inline-flex items-center rounded-md border border-border px-2 py-1 text-xs text-brand-text hover:bg-muted', focusRingInset)}>{file.title} · v{file.revision}</Link>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {repositories.map((name) => <span key={name}>{name}</span>)}
            <time>{new Date(message.createdAt).toLocaleString()}</time>
          </div>
        </MessageContent>
      </div>
    </Message>
  );
}

// A Run's live state is one transcript card at the position of its latest activity: a
// quiet status row while it runs, an actionable failure card when it fails. Controls act
// on the whole Run and report progress on themselves.
function RunStatusCard({ run, roleName, failureReason, controlKey, onControl }: {
  run: GroupRun;
  roleName: (role: string) => string;
  failureReason: string;
  controlKey: string;
  onControl: (operation: 'pause' | 'resume' | 'cancel' | 'retry' | 'reexecute') => void;
}) {
  const { t } = useTranslation('agentTeams');
  const busy = controlKey.split(':')[1]?.split(',').includes(run.id) ?? false;
  const active = ACTIVE_RUN_STATUSES.includes(run.status);
  const role = run.currentRole ?? run.targetRole ?? 'team-manager';

  if (run.status === 'failed') {
    return (
      <div className="wl-enter my-2 flex items-start gap-2.5 rounded-xl border border-danger/25 bg-danger-subtle px-4 py-3" role="alert">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="inline-flex shrink-0 items-center rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground">@{roleName(role)}</span>
            <span className="font-medium text-danger">{t('run.status.failed')}</span>
          </div>
          {failureReason ? <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] text-danger">{failureReason}</p> : null}
          <p className="mt-1 truncate text-xs text-muted-foreground">{run.intent}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <RunControl label={t('group.retry')} icon={<RefreshCw className="size-3.5" aria-hidden="true" />} busy={busy} onActivate={() => onControl('retry')} />
            <RunControl label={t('group.reexecute')} icon={<RotateCcw className="size-3.5" aria-hidden="true" />} busy={busy} onActivate={() => onControl('reexecute')} />
            <OpenRunLink runId={run.id} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wl-enter my-2 flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 shadow-xs" role="status">
      <span className="inline-flex shrink-0 items-center rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium">@{roleName(role)}</span>
      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        {run.status === 'running' || run.status === 'queued' ? <span className="wl-live text-brand" aria-hidden="true" /> : null}
        {t(`run.status.${run.status}`)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{run.intent}</span>
      <span className="flex shrink-0 items-center gap-0.5">
        {run.status === 'paused' ? <RunControl label={t('group.continue')} icon={<Play className="size-3.5" aria-hidden="true" />} busy={busy} onActivate={() => onControl('resume')} /> : active ? <RunControl label={t('group.pause')} icon={<Pause className="size-3.5" aria-hidden="true" />} busy={busy} onActivate={() => onControl('pause')} /> : null}
        {active ? <RunControl label={t('group.stop')} icon={<Square className="size-3.5" aria-hidden="true" />} busy={busy} onActivate={() => onControl('cancel')} /> : null}
        <OpenRunLink runId={run.id} />
      </span>
    </div>
  );
}

function OpenRunLink({ runId }: { runId: string }) {
  const { t } = useTranslation('agentTeams');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link to="/agent-team-runs/$runId" params={{ runId }} aria-label={t('group.openRun')} className={cn('wl-press inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-subtle hover:text-foreground', focusRingInset)}>
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </Link>
      </TooltipTrigger>
      <TooltipContent>{t('group.openRun')}</TooltipContent>
    </Tooltip>
  );
}

function RunControl({ label, icon, busy, onActivate }: { label: string; icon: ReactNode; busy: boolean; onActivate: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} disabled={busy} className={cn('wl-press inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-subtle hover:text-foreground disabled:opacity-40', focusRingInset)} onClick={onActivate}>
          {busy ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" /> : icon}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function QuestionCard({ run, pendingInput, onSubmit }: {
  run: GroupRun;
  pendingInput: GroupPendingInput;
  onSubmit: (answer: string, commands: string[], directories: string[]) => Promise<void>;
}) {
  const { t } = useTranslation('agentTeams');
  const [answer, setAnswer] = useState('');
  const [commands, setCommands] = useState('');
  const [directory, setDirectory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const needsDirectory = run.repositoryIds.length === 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = answer.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(
        trimmed,
        commands.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        directory.trim() ? [directory.trim()] : [],
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('group.answerFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="wl-enter my-2 space-y-3 rounded-2xl border border-warning/30 bg-warning-subtle px-4 py-3" onSubmit={(event) => void submit(event)} aria-label={t('run.status.waiting_for_input')}>
      <div className="flex items-start gap-2 text-sm">
        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1"><MessageResponse content={pendingInput.question} /></div>
      </div>
      <Textarea value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={t('group.answerPlaceholder')} aria-label={t('group.answer')} />
      {needsDirectory ? (
        <Field label={t('group.answerDirectories')} htmlFor={`group-answer-directory-${pendingInput.id}`} hint={t('group.answerDirectoriesHint')}>
          <Input id={`group-answer-directory-${pendingInput.id}`} value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="/absolute/path/to/project" />
        </Field>
      ) : null}
      <Field label={t('group.authorizedCommands')} htmlFor={`group-commands-${pendingInput.id}`} hint={t('group.authorizedCommandsHint')}>
        <Textarea id={`group-commands-${pendingInput.id}`} value={commands} onChange={(event) => setCommands(event.target.value)} placeholder={t('group.commandsPlaceholder')} />
      </Field>
      {error ? <p className="text-[13px] text-danger" role="alert">{error}</p> : null}
      <Button type="submit" size="compact" disabled={!answer.trim() || busy} aria-busy={busy}>
        {busy ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}{busy ? t('group.answering') : t('group.answer')}
      </Button>
    </form>
  );
}

function AddDirectoryDialog({ open, onOpenChange, onAdd }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (directory: string) => Promise<void>;
}) {
  const { t } = useTranslation('agentTeams');
  const [directory, setDirectory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = directory.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError('');
    try {
      await onAdd(trimmed);
      setDirectory('');
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('group.repositoryAddFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('group.repositories')}</DialogTitle>
          <DialogDescription>{t('group.addRepositoryHint')}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <Field label={t('group.repositoryDirectory')} htmlFor="agent-team-group-add-directory">
            <Input id="agent-team-group-add-directory" value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="/absolute/path/to/repository" />
          </Field>
          {error ? <p className="text-[13px] text-danger" role="alert">{error}</p> : null}
          <DialogFooter>
            <Button type="submit" size="compact" disabled={!directory.trim() || busy} aria-busy={busy}>
              {busy ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}{t('group.addRepository')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function roleTranslationKey(role: string): string {
  return role.replaceAll('-', '_');
}

function parseGroupRoleControl(body: string, availableRoles: readonly AgentTeamRoleId[]): { role: AgentTeamRoleId; operation: 'pause' | 'resume' | 'cancel' | 'retry' | 'reexecute' } | null {
  const match = /^@([a-z0-9_-]+)\s+(pause|resume|cancel|retry|reexecute)$/i.exec(body);
  if (!match) return null;
  const typedRole = match[1]!.toLowerCase();
  const role = availableRoles.find((item) => item.toLowerCase() === typedRole)
    ?? availableRoles.find((item) => item.toLowerCase() === typedRole.replaceAll('-', '_'));
  if (!role) return null;
  return { role, operation: match[2]!.toLowerCase() as 'pause' | 'resume' | 'cancel' | 'retry' | 'reexecute' };
}

function parseGroupAddress(body: string, availableRoles: readonly AgentTeamRoleId[]): { role: AgentTeamRoleId; body: string } | null {
  const match = /^@([a-z0-9_-]+)\s+([\s\S]+)$/i.exec(body);
  if (!match) return null;
  const typedRole = match[1]!.toLowerCase();
  const role = availableRoles.find((item) => item.toLowerCase() === typedRole)
    ?? availableRoles.find((item) => item.toLowerCase() === typedRole.replaceAll('-', '_'));
  const message = match[2]!.trim();
  if (!role || !message) return null;
  return { role, body: message };
}
