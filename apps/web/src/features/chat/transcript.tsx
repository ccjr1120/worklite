import { Link } from '@tanstack/react-router';
import { Activity, Ban, ChevronDown, ChevronRight, CircleX, FileCode2, Hourglass, LoaderCircle, MessageCircleQuestion, MessageSquareText, Play, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { memo, createContext, useContext, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentExecutionView, AgentToolCallView, ChatConversationView, ChatProjectTaskView, ChatSubmissionView, RunView, WorkflowView } from '@worklite/contracts';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { isLiveStatus, StatusBadge, toStatusKey, type StatusKey } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { focusRingInset, surfaceInteraction } from '@/components/ui/interaction';
import { Skeleton } from '@/components/ui/skeleton';
import { TruncatedText } from '@/components/ui/truncated-text';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import type { AppLocale } from '@/i18n/locale';
import { cn } from '@/lib/utils';
import { toSingleLine } from '@/lib/single-line';
import { ApiError, api } from '@/api/client';
import { useChatProjectOperationQuery } from '@/api/queries';
import { PinTrackingContext } from './pinned-executions';

type TranscriptMessage = AgentExecutionView['messages'][number];
type TurnSegment = { kind: 'message'; item: TranscriptMessage } | { kind: 'tool'; item: AgentToolCallView } | { kind: 'question'; item: AgentToolCallView; text: string };


type CodexActivity = ChatProjectTaskView['activities'][number];
type CodexOperation = ChatProjectTaskView['operations'][number];

function codexActivityText(activity: CodexActivity, key: string): string | null {
  const value = activity[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

type CodexActivityGroup = 'messages' | 'tools' | 'lifecycle';

// Groups persisted executor activities for the expanded detail view: reply text,
// tool/command work, and lifecycle markers. Mirrors the server-side stage derivation.
function codexActivityGroup(activity: CodexActivity): CodexActivityGroup {
  const phase = codexActivityText(activity, 'phase') ?? '';
  if (phase.endsWith('agent_message') || (phase.endsWith('item_completed') && codexActivityText(activity, 'text'))) return 'messages';
  if (/tool_started|tool_completed|mcp\.call|project\.tool|item_started|item_completed/.test(phase)) return 'tools';
  return 'lifecycle';
}

function CodexOperationDisclosure({ taskId, operation }: { taskId: string; operation: CodexOperation }) {
  const { t } = useTranslation('assistant');
  const [open, setOpen] = useState(false);
  const query = useChatProjectOperationQuery(taskId, operation.key, open);
  const activate = () => {
    if (!open) { setOpen(true); return; }
    if (query.isError) { void query.refetch(); return; }
    setOpen(false);
  };
  return (
    <div className="mt-2">
      <Button type="button" variant="secondary" size="compact" aria-expanded={open} onClick={activate}>
        {open ? query.isError ? t('codex.operation.retryDetails') : t('codex.operation.hideDetails') : t('codex.operation.details')}
      </Button>
      {open ? (
        <div className="mt-2" aria-live="polite">
          {query.isPending ? <p className="text-xs text-muted-foreground">{t('codex.operation.loading')}</p> : null}
          {query.isError ? <p className="text-xs text-danger" role="alert">{t('codex.operation.detailError')}</p> : null}
          {query.data ? <pre className="max-h-72 overflow-auto rounded-md border border-border bg-background p-2.5 font-mono text-xs"><code className="whitespace-pre-wrap break-all">{JSON.stringify(query.data.result, null, 2) ?? 'null'}</code></pre> : null}
        </div>
      ) : null}
    </div>
  );
}

type PendingReceipt = ChatConversationView['pendingReceipts'][number];
type ActiveWorkflowRun = { workflow: WorkflowView; run: RunView; input: string };

// Every transcript entry carries its own timestamp and the transcript is that one sequence; no category is
// appended after the conversation. Unsent queued messages are rendered by the caller after the sequence.
type TimelineEntry =
  | { kind: 'user'; item: TranscriptMessage }
  | { kind: 'assistant'; segments: TurnSegment[] }
  | { kind: 'summaryDivider'; item: TranscriptMessage }
  | { kind: 'task'; submission: ChatSubmissionView }
  | { kind: 'workflowRun'; active: ActiveWorkflowRun }
  | { kind: 'receipt'; receipt: PendingReceipt }
  | { kind: 'question'; question: NonNullable<AgentExecutionView['pendingQuestion']> }
  | { kind: 'cancelled' }
  | { kind: 'failure' };

type TimedEntry = { at: string; order: number; entry: TimelineEntry | { kind: 'segment'; segment: TurnSegment } };

// One Chat turn is one identity block: every assistant message and Skill call between two other entries
// shares a single avatar and content column, so a turn that answers, runs a script, and answers again does
// not read as three speakers. A task card or other entry between them splits the turn at its time.
function buildTimeline(sources: {
  execution: AgentExecutionView | null;
  submissions: ChatSubmissionView[];
  workflowRun: ActiveWorkflowRun | null;
  receipts: PendingReceipt[];
  question: AgentExecutionView['pendingQuestion'];
  cancelled: boolean;
  failed: boolean;
}): TimelineEntry[] {
  const timed: TimedEntry[] = [];
  const push = (at: string, entry: TimedEntry['entry']) => timed.push({ at, order: timed.length, entry });
  const execution = sources.execution;
  for (const item of execution?.messages ?? []) {
    // A summary divider is a marker between turns, never a spoken message in a turn.
    if (item.kind === 'summary_divider') { push(item.createdAt, { kind: 'summaryDivider', item }); continue; }
    push(item.createdAt, { kind: 'segment', segment: { kind: 'message', item } });
  }
  for (const item of execution?.toolCalls ?? []) {
    if (!item.question) { push(item.createdAt, { kind: 'segment', segment: { kind: 'tool', item } }); continue; }
    // An active question is represented only by the pending question note. A settled one stays
    // as an exchange: its question line in the asking turn and the answer as a user message.
    if (item.status === 'running') continue;
    push(item.createdAt, { kind: 'segment', segment: { kind: 'question', item, text: item.question.text } });
    if (item.question.answer) push(item.finishedAt ?? item.createdAt, { kind: 'segment', segment: { kind: 'message', item: { id: `${item.id}:answer`, role: 'user', content: item.question.answer, createdAt: item.finishedAt ?? item.createdAt } } });
  }
  for (const submission of sources.submissions) {
    if (submission.reference?.kind !== 'conversation' && (submission.reference || submission.error)) push(submission.createdAt, { kind: 'task', submission });
  }
  if (sources.workflowRun) push(sources.workflowRun.run.startedAt, { kind: 'workflowRun', active: sources.workflowRun });
  for (const receipt of sources.receipts) push(receipt.createdAt, { kind: 'receipt', receipt });
  if (sources.question) push(sources.question.createdAt, { kind: 'question', question: sources.question });
  if (execution && sources.cancelled) push(execution.updatedAt, { kind: 'cancelled' });
  if (execution && sources.failed) push(execution.updatedAt, { kind: 'failure' });
  timed.sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.order - right.order);

  const entries: TimelineEntry[] = [];
  for (const { entry } of timed) {
    if (entry.kind !== 'segment') { entries.push(entry); continue; }
    const { segment } = entry;
    if (segment.kind === 'message' && segment.item.role === 'user') { entries.push({ kind: 'user', item: segment.item }); continue; }
    const last = entries[entries.length - 1];
    if (last?.kind === 'assistant') last.segments.push(segment);
    else entries.push({ kind: 'assistant', segments: [segment] });
  }
  return entries;
}

// A pending message has been submitted but not yet accepted by the server; it keeps its
// place with reduced emphasis while the working note below it reports progress.
// Memoized on message identity: timeline rebuilds keep settled messages referentially stable,
// so a streaming turn does not re-render earlier messages.
const UserMessage = memo(function UserMessage({ message, pending = false }: { message: TranscriptMessage; pending?: boolean }) {
  const { t } = useTranslation('assistant');
  return (
    <Message from="user" aria-label={t('speaker.you')} aria-busy={pending || undefined} className="wl-enter">
      <MessageContent className={cn('max-w-[min(78%,640px)] rounded-2xl rounded-br-md bg-brand-subtle px-4 py-2.5 transition-opacity duration-[140ms] ease-[var(--ease-out)]', pending && 'opacity-60')}>
        <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.content}</p>
      </MessageContent>
    </Message>
  );
}, (left, right) => left.pending === right.pending && left.message === right.message);

function sameSegments(left: TurnSegment[], right: TurnSegment[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment.kind === right[index].kind && segment.item === right[index].item);
}

const AssistantTurn = memo(function AssistantTurn({ segments, working, markdownEnabled }: {
  segments: TurnSegment[];
  working: boolean;
  markdownEnabled: boolean;
}) {
  const { t } = useTranslation('assistant');
  return (
    <Message from="assistant" aria-label={t('speaker.assistant')} className="wl-enter">
      <div className="flex w-full items-start gap-3">
        <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface shadow-xs transition-shadow duration-[200ms]', working && 'wl-live-glow border-transparent')}>
          <MessageSquareText className={cn('size-4 transition-colors duration-[200ms]', working ? 'text-brand' : 'text-muted-foreground')} aria-hidden="true" />
        </span>
        <MessageContent className="min-w-0 flex-1 pt-1">
          {segments.map((segment, index) => segment.kind === 'message'
            ? segment.item.progressReport
              ? <ProgressReportCard key={segment.item.id} message={segment.item} report={segment.item.progressReport} streaming={working && index === segments.length - 1} markdownEnabled={markdownEnabled} />
              : <MessageResponse key={segment.item.id} content={segment.item.content} enabled={markdownEnabled} className={working && index === segments.length - 1 ? 'wl-caret' : undefined} />
            : segment.kind === 'question'
              ? <AskedQuestion key={segment.item.id} text={segment.text} />
              : <ToolCallPanel key={segment.item.id} call={segment.item} />)}
          {working && segments[segments.length - 1]?.kind !== 'message' ? <WorkingNote /> : null}
        </MessageContent>
      </div>
    </Message>
  );
}, (left, right) => left.working === right.working && left.markdownEnabled === right.markdownEnabled && sameSegments(left.segments, right.segments));

// Expansion is one shared choice for the whole conversation: every progress card follows it,
// so a later periodic report keeps the reader's current selection. The owner resets it to the
// compact default when the conversation changes or the page reloads.
export const ProgressReportExpansionContext = createContext<{ expanded: boolean; toggle: () => void }>({ expanded: false, toggle: () => undefined });

function ProgressReportCard({ message, report, streaming, markdownEnabled }: {
  message: TranscriptMessage;
  report: NonNullable<TranscriptMessage['progressReport']>;
  streaming: boolean;
  markdownEnabled: boolean;
}) {
  const { t } = useTranslation('assistant');
  const { locale } = useLocale();
  const { expanded, toggle } = useContext(ProgressReportExpansionContext);
  const titleId = useId();
  const contentId = useId();
  // The collapsed line keeps the "work is alive" signal: the count plus the most recently
  // changed item, chosen by the captured update time rather than list order.
  const latest = report.items.reduce<typeof report.items[number] | null>((current, item) => (item.updatedAt ?? '') >= (current?.updatedAt ?? '') ? item : current, null);
  return (
    <article className="my-2" aria-labelledby={titleId} aria-busy={streaming || undefined}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        aria-label={expanded ? t('progress.collapse') : t('progress.expand')}
        onClick={toggle}
        className={cn('flex min-h-9 w-full items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-left shadow-xs hover:bg-surface-subtle/70', surfaceInteraction, focusRingInset)}
      >
        <Activity className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[13px]">
          <span id={titleId} className="font-medium">{t('progress.title')}</span>
          <span className="text-muted-foreground"> · {t('progress.compactCount', { count: report.items.length })}</span>
          {latest ? <span className="text-muted-foreground"> · {t('progress.compactLatest', { title: latest.title })}</span> : null}
        </span>
        <time dateTime={message.createdAt} className="shrink-0 text-xs text-muted-foreground">{formatDateTime(message.createdAt, locale)}</time>
        <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-[200ms] ease-[var(--ease-out)]', !expanded && '-rotate-90')} aria-hidden="true" />
      </button>
      {expanded ? (
        <div id={contentId} className="wl-fade mt-2 rounded-xl border border-border bg-surface p-3.5 shadow-xs">
          <ul className="space-y-2.5">
            {report.items.map((item) => (
              <li key={`${item.kind}:${item.id}`} className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">{t(`progress.kind.${item.kind}`)}</p>
                  <p className="break-words text-sm font-medium leading-5">{item.title}</p>
                  <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{item.id}</p>
                  {item.stage ? <p className="mt-0.5 text-xs text-muted-foreground">{t('progress.stage', { stage: item.kind === 'task' ? t(`codex.stage.${item.stage}`, { defaultValue: item.stage }) : item.stage })}</p> : null}
                  {item.progress ? <p className="mt-0.5 break-words text-xs text-muted-foreground">{item.progress}</p> : null}
                </div>
                <StatusBadge status={toStatusKey(item.status)} className="shrink-0" />
              </li>
            ))}
          </ul>
          <div className="mt-3 border-t border-border pt-3">
            <MessageResponse content={message.content} enabled={markdownEnabled} className={streaming ? 'wl-caret' : undefined} />
          </div>
        </div>
      ) : null}
    </article>
  );
}

// A settled question is part of the reply that asked it, so it reads as quiet assistant text
// rather than the amber waiting note it replaced.
function AskedQuestion({ text }: { text: string }) {
  return (
    <p className="wl-fade my-2 flex items-start gap-2 text-sm text-muted-foreground">
      <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 whitespace-pre-wrap break-words">{text}</span>
    </p>
  );
}

function WorkingNote() {
  const { t } = useTranslation('assistant');
  return (
    <p className="wl-fade inline-flex items-center gap-2.5 rounded-full bg-brand-subtle px-3 py-1.5 text-[13px] font-medium text-brand-text" role="status">
      <span className="wl-live text-brand" aria-hidden="true" />
      {t('execution.working')}
    </p>
  );
}

// The skeleton stands in for the messages being loaded. Its shape is decorative, so the
// loading state itself is announced once as text rather than through the placeholder.
function TranscriptSkeleton() {
  const { t } = useTranslation('assistant');
  return (
    <>
      <p className="sr-only" role="status">{t('execution.loading')}</p>
      <div className="space-y-5 py-2" aria-hidden="true">
        <div className="flex justify-end"><Skeleton className="h-16 w-[min(60%,360px)] rounded-md" /></div>
        <div className="flex items-start gap-3">
          <Skeleton className="size-8 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-[85%]" />
            <Skeleton className="h-4 w-[70%]" />
            <Skeleton className="h-4 w-[45%]" />
          </div>
        </div>
      </div>
    </>
  );
}

function QuestionNote({ question, onAnswer, busy }: { question: NonNullable<AgentExecutionView['pendingQuestion']>; onAnswer: (answer: string, authorization?: { recoveryDecision?: 'adopt_command' | 'mark_failed'; newConversation?: boolean }) => void; busy: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const { t } = useTranslation('assistant');
  return (
    <div className="wl-enter my-3 rounded-xl border border-warning/30 bg-warning-subtle px-4 py-3" role="status">
      <p className="flex items-start gap-2 text-sm font-medium"><Hourglass className="wl-breathe mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />{question.question}</p>
      {question.action === 'new_conversation' ? <Button type="button" variant="secondary" size="compact" className="mt-2" disabled={busy} onClick={() => onAnswer(t('history.new'), { newConversation: true })}>{busy ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" /> : null}{t('history.new')}</Button> : null}
      {question.recovery ? <div className="mt-2 flex flex-wrap gap-2">
        {question.recovery.commandExecutionId ? <Button type="button" variant="secondary" size="compact" disabled={busy} onClick={() => onAnswer(t('codex.adopt'), { recoveryDecision: 'adopt_command' })}>{t('codex.adopt')}</Button> : null}
        <Button type="button" variant="secondary" size="compact" disabled={busy} onClick={() => onAnswer(t('codex.markFailed'), { recoveryDecision: 'mark_failed' })}>{t('codex.markFailed')}</Button>
      </div> : null}
      {question.options.length > 0 ? <div className="mt-2 flex flex-wrap gap-2">{question.options.map((option) => <Button key={option} type="button" variant="secondary" size="compact" disabled={busy} onClick={() => { setSelected(option); onAnswer(option); }}>{busy && selected === option ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" /> : null}{option}</Button>)}</div> : null}
    </div>
  );
}

// A cancellation is a state, not a speaker, so it renders without an identity mark
// while keeping its own status region for assistive technology.
function CancelledNote() {
  const { t } = useTranslation('assistant');
  return (
    <p className="wl-fade flex items-center gap-2 py-3 text-[13px] text-muted-foreground" role="status">
      <Ban className="size-4 shrink-0" aria-hidden="true" />
      {t('execution.cancelled')}
    </p>
  );
}

// A summarize divider separates the compressed history from the continuing conversation.
// It is a persisted state marker, not a message, so it renders without an identity mark.
// A divider whose message carries the summary text toggles that text in place; one without
// content stays a plain marker.
const SummaryDivider = memo(function SummaryDivider({ label, message }: { label: string; message: TranscriptMessage }) {
  const { t } = useTranslation('assistant');
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const summary = message.content.trim();
  if (!summary) {
    return (
      <div className="wl-fade flex items-center gap-3 py-3" role="separator" aria-label={label}>
        <div className="h-px flex-1 bg-border" aria-hidden="true" />
        <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
        <div className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>
    );
  }
  return (
    <div className="wl-fade py-3">
      <div className="flex items-center gap-3" role="separator" aria-label={label}>
        <div className="h-px flex-1 bg-border" aria-hidden="true" />
        <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
        <div className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>
      <div className="mt-1 flex justify-center">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
          className={cn('inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs text-muted-foreground hover:bg-surface-subtle hover:text-foreground', focusRingInset)}
        >
          {expanded ? t('summarize.hideSummary') : t('summarize.showSummary')}
          <ChevronDown className={cn('size-3 transition-transform duration-[120ms]', expanded && 'rotate-180')} aria-hidden="true" />
        </button>
      </div>
      {expanded ? (
        <div id={contentId} className="wl-fade mt-2 rounded-lg border border-border bg-surface px-4 py-3">
          <MessageResponse content={summary} enabled />
        </div>
      ) : null}
    </div>
  );
});

function FailureNote({ execution, message, onRetry, retryDisabled, locale }: { execution: AgentExecutionView | null; message: string; onRetry: () => void; retryDisabled: boolean; locale: AppLocale }) {
  const { t } = useTranslation('assistant');
  if (!execution) return null;
  return (
    <div className="wl-enter my-2 flex items-start gap-2.5 rounded-xl border border-danger/25 bg-danger-subtle px-4 py-3 text-[13px] text-danger" role="alert">
      <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p>{message}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button type="button" variant="link" size="sm" className="h-auto px-0 text-danger" disabled={retryDisabled} onClick={onRetry}>
            <RefreshCw className="mr-1 size-3.5" aria-hidden="true" />{t('execution.retry')}
          </Button>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">{t('execution.diagnostics')}</summary>
            <dl className="mt-2 grid gap-1 font-mono">
              <div><dt className="inline font-sans">{t('execution.id')}: </dt><dd className="inline break-all">{execution.id}</dd></div>
              <div><dt className="inline font-sans">{t('execution.phase')}: </dt><dd className="inline">{execution.phase}</dd></div>
              <div><dt className="inline font-sans">{t('execution.errorCode')}: </dt><dd className="inline">{execution.errorCode ?? t('execution.none')}</dd></div>
              <div><dt className="inline font-sans">{t('execution.updated')}: </dt><dd className="inline font-sans">{formatDateTime(new Date(execution.updatedAt), locale)}</dd></div>
            </dl>
          </details>
        </div>
      </div>
    </div>
  );
}

function QueueRows({ queued, paused, sendingId, onRemove }: { queued: Array<{ id: string; text: string }>; paused: boolean; sendingId: string | null; onRemove: (id: string) => void }) {
  const { t } = useTranslation('assistant');
  if (queued.length === 0) return null;
  return (
    <section className="wl-enter mt-3 rounded-xl border border-dashed border-border bg-surface-subtle/60 p-3" role="status" aria-label={t('queue.title', { count: queued.length })}>
      <p className="text-xs font-medium text-muted-foreground">{t('queue.title', { count: queued.length })}</p>
      <ol className="mt-2 space-y-1.5">
        {queued.map((item, index) => (
          <li key={item.id} className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground">{index + 1}</span>
            <TruncatedText text={item.text} className="flex-1 text-[13px] leading-5" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon-compact" aria-label={t('queue.remove')} disabled={sendingId === item.id} onClick={() => onRemove(item.id)}>
                  {sendingId === item.id ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" /> : <X className="size-3.5" aria-hidden="true" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('queue.remove')}</TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ol>
      {paused ? <p className="mt-2 text-xs text-muted-foreground">{t('queue.paused')}</p> : null}
    </section>
  );
}

function WorkflowRunRow({ run, workflow, input }: { run: RunView; workflow: WorkflowView; input: string }) {
  const { t } = useTranslation('assistant');
  const statusKey = toStatusKey(run.status);
  const live = isLiveStatus(run.status);
  const failure = run.nodeRuns?.find((nodeRun) => nodeRun.status === 'failed')?.error;
  const pins = useContext(PinTrackingContext);
  return (
    <div ref={pins?.track(run.id)} tabIndex={-1} className={cn('wl-enter my-3 rounded-xl border bg-surface p-3.5 shadow-xs outline-none transition-[border-color,box-shadow] duration-[200ms]', live ? 'border-brand/40 wl-live-glow' : 'border-border')} role="status">
      <div className="flex items-start gap-3">
        <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full', live ? 'bg-brand-subtle' : 'bg-surface-subtle')}>
          <Play className={cn('size-4', live ? 'text-brand' : 'text-muted-foreground')} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm font-semibold">{workflow.name}</span>
            <StatusBadge key={statusKey} status={statusKey} label={run.status === 'waiting_for_input' ? t('workflowRun.waitingForConfirmation') : t(`status.${run.status === 'succeeded' ? 'completed' : run.status === 'timed_out' ? 'failed' : run.status}`)} />
          </div>
          <TruncatedText as="p" text={input || t('workflowRun.emptyInput')} className="mt-1 text-[13px] text-muted-foreground" />
          {run.currentStep ? <TruncatedText as="p" text={t('workflowRun.currentStep', { step: run.currentStep })} className="mt-1 text-xs text-muted-foreground" /> : null}
          {run.status === 'waiting_for_input' ? <p className="mt-2 text-xs text-muted-foreground">{t('workflowRun.openRunHistory')}</p> : null}
          {failure ? <TruncatedText as="p" text={toSingleLine(failure)} title={failure} className="mt-2 text-xs text-danger" /> : null}
          {run.artifacts && run.artifacts.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {run.artifacts.map((artifact) => (
                <Link key={artifact.id} to="/artifacts/$artifactId" params={{ artifactId: artifact.id }} className="text-xs font-medium text-brand-text underline-offset-2 hover:underline">
                  {artifact.name}
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CodexActivityGroupSection({ groupKey, items, describeActivity, locale }: { groupKey: CodexActivityGroup; items: CodexActivity[]; describeActivity: (activity: CodexActivity) => string; locale: AppLocale }) {
  const { t } = useTranslation('assistant');
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="secondary" size="compact" className="w-full max-w-full justify-start text-left">
          <span className="min-w-0 truncate">{t(`codex.activityGroup.${groupKey}`, { count: items.length })}</span>
          <ChevronRight className={cn('ml-auto size-3 shrink-0 transition-transform duration-[120ms]', open && 'rotate-90')} aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="mt-1 max-h-64 space-y-1 overflow-y-auto rounded-md border border-border bg-surface-subtle/50 p-2">
          {items.map((activity, index) => {
            const createdAt = codexActivityText(activity, 'createdAt');
            return (
              <li key={`${createdAt ?? codexActivityText(activity, 'phase') ?? 'activity'}-${index}`} className="flex gap-2 py-1">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  {codexActivityText(activity, 'text') ? <MessageResponse content={codexActivityText(activity, 'text')!} enabled /> : <p className="break-words text-xs font-medium">{describeActivity(activity)}</p>}
                  {createdAt ? <p className="mt-0.5 text-[11px] text-muted-foreground">{formatDateTime(createdAt, locale)}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

function CodexToolCallPanel({ task: inputTask }: { task: ChatProjectTaskView }) {
  const { t } = useTranslation('assistant');
  const { locale } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [cancellingTask, setCancellingTask] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  const [taskSnapshot, setTaskSnapshot] = useState<ChatProjectTaskView | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const task = taskSnapshot?.id === inputTask.id && Date.parse(taskSnapshot.updatedAt) >= Date.parse(inputTask.updatedAt)
    ? taskSnapshot
    : inputTask;
  const statusKey = toStatusKey(task.status);
  const live = isLiveStatus(task.status);
  const pendingQuestion = task.status === 'waiting_for_input' ? task.pendingQuestion : null;
  const pins = useContext(PinTrackingContext);
  const expandRequest = pins?.expandRequest;
  useEffect(() => {
    if (expandRequest?.id === task.id) setExpanded(true);
  }, [expandRequest, task.id]);
  useEffect(() => {
    if (!live) return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [live, task.id]);
  useEffect(() => {
    if (!live && !cancellingTask) setCancelDialogOpen(false);
  }, [live, cancellingTask]);
  // Expanding the detail view lazy-loads the full persisted activity log (the embedded
  // task payload only carries the recent window used by the collapsed row).
  const [fullActivities, setFullActivities] = useState<CodexActivity[] | null>(null);
  const [activitiesTruncated, setActivitiesTruncated] = useState(false);
  useEffect(() => {
    if (!expanded || fullActivities) return;
    let cancelled = false;
    api.chatProjectTask(task.id, 'full').then((view) => {
      if (cancelled) return;
      setFullActivities(view.activities);
      setActivitiesTruncated(Boolean(view.activitiesTruncated));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [expanded, fullActivities, task.id]);
  const cancelTask = async () => {
    if (cancellingTask) return;
    setCancellingTask(true);
    setActionError('');
    try {
      const updated = await api.cancelChatProjectTask(task.id);
      setTaskSnapshot(updated);
      if (isLiveStatus(updated.status)) {
        setActionError(t('codex.cancelStillRunning'));
        return;
      }
      setCancelDialogOpen(false);
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : t('codex.cancelFailed'));
    } finally {
      setCancellingTask(false);
    }
  };
  const goalSummary = toSingleLine(task.goal);
  const executorName = task.executor ? t(`codex.executorName.${task.executor}`) : t('codex.launchNotCaptured');
  const modelSummary = t('codex.modelLaunch', { model: task.model || t('codex.defaultModel'), mode: executorName });
  const latestActivity = task.activities.at(-1) ?? null;
  const createdAtMs = Date.parse(task.createdAt);
  const finishedAtMs = live ? clockNow : Date.parse(task.updatedAt);
  const elapsedMinutes = Number.isFinite(createdAtMs) && Number.isFinite(finishedAtMs)
    ? Math.max(0, Math.floor((finishedAtMs - createdAtMs) / 60_000))
    : 0;
  const elapsedDuration = elapsedMinutes < 1
    ? t('codex.elapsedLessThanMinute')
    : elapsedMinutes < 60
      ? t('codex.elapsedMinutes', { count: elapsedMinutes })
      : elapsedMinutes < 24 * 60
        ? t('codex.elapsedHours', { count: Math.floor(elapsedMinutes / 60), remainder: elapsedMinutes % 60 })
        : t('codex.elapsedDays', { count: Math.floor(elapsedMinutes / (24 * 60)), remainder: Math.floor((elapsedMinutes % (24 * 60)) / 60) });
  const visibleActivities = fullActivities ?? task.activities;
  const activityGroups: Record<CodexActivityGroup, CodexActivity[]> = { messages: [], tools: [], lifecycle: [] };
  for (const activity of visibleActivities) activityGroups[codexActivityGroup(activity)].push(activity);
  const visibleOperations = task.operations;
  const rawJson = rawOpen ? JSON.stringify(task, null, 2) : '';

  const describeItem = (itemType: string | null) => {
    if (!itemType) return t('codex.activity.unknownItem');
    if (itemType === 'reasoning') return t('codex.itemType.reasoning');
    if (itemType === 'command_execution') return t('codex.itemType.command_execution');
    if (itemType === 'file_change') return t('codex.itemType.file_change');
    if (itemType === 'agent_message') return t('codex.itemType.agent_message');
    if (itemType === 'mcp_tool_call') return t('codex.itemType.mcp_tool_call');
    if (itemType === 'web_search') return t('codex.itemType.web_search');
    if (itemType === 'todo_list') return t('codex.itemType.todo_list');
    return itemType;
  };

  const describeActivity = (activity: CodexActivity) => {
    const phase = codexActivityText(activity, 'phase') ?? '';
    const itemType = codexActivityText(activity, 'itemType');
    if (phase === 'claude.agent_message' || (phase === 'codex.item_completed' && codexActivityText(activity, 'text'))) return t('codex.activity.message');
    if (phase === 'codex.started') return t('codex.activity.started', { executor: t('codex.executorName.codex') });
    if (phase === 'codex.thread_started') return t('codex.activity.threadStarted', { executor: t('codex.executorName.codex') });
    if (phase === 'codex.turn_started') return t('codex.activity.turnStarted');
    if (phase === 'codex.completed') return t('codex.activity.completed', { executor: t('codex.executorName.codex') });
    if (phase === 'codex.item_started') return t('codex.activity.itemStarted', { type: codexActivityText(activity, 'summary') ?? describeItem(itemType) });
    if (phase === 'codex.item_completed') return t('codex.activity.itemCompleted', { type: describeItem(itemType) });
    if (phase === 'claude.started') return t('codex.activity.started', { executor: t('codex.executorName.claude') });
    if (phase === 'claude.session_started') return t('codex.activity.threadStarted', { executor: t('codex.executorName.claude') });
    if (phase === 'claude.completed') return t('codex.activity.completed', { executor: t('codex.executorName.claude') });
    if (phase === 'claude.tool_started') return t('codex.activity.itemStarted', { type: codexActivityText(activity, 'summary') ?? describeItem(itemType) });
    if (phase === 'claude.tool_completed') return t('codex.activity.itemCompleted', { type: describeItem(itemType) });
    if (phase === 'project.tool') return t('codex.activity.projectTool', { tool: codexActivityText(activity, 'toolName') ?? t('codex.activity.unknownTool') });
    if (phase === 'mcp.call') return t('codex.activity.mcpCall', { tool: codexActivityText(activity, 'toolName') ?? t('codex.activity.unknownTool') });
    return t('codex.activity.unknown', { phase });
  };
  const progressLine = task.progressText.trim()
    ? toSingleLine(task.progressText)
    : latestActivity ? describeActivity(latestActivity) : t('codex.starting');
  const progressSummary = progressLine.length > 120 ? `${progressLine.slice(0, 119)}…` : progressLine;
  const activityPhaseSummary = Object.entries(task.activityPhases).map(([phase, count]) => `${describeActivity({ phase })} · ${count}`);
  const operationStatusSummary = Object.entries(task.operationStatuses).map(([status, count]) => `${t(`codex.operationStatus.${status}`, { defaultValue: status })} · ${count}`);

  return (
    <article
      ref={pins?.track(task.id)}
      tabIndex={-1}
      className={cn('wl-enter my-2 overflow-hidden rounded-lg border bg-surface shadow-xs transition-[border-color,box-shadow] duration-[200ms] outline-none', live ? 'border-brand/40 wl-live-glow' : task.status === 'failed' ? 'border-danger/30' : 'border-border')}
      aria-label={t('codex.panel')}
    >
      <button
        type="button"
        className={cn('flex min-h-11 w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-surface-subtle/70', surfaceInteraction, focusRingInset)}
        aria-expanded={expanded}
        aria-controls={`project-task-details-${task.id}`}
        aria-label={expanded ? t('codex.collapse') : t('codex.expand')}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm bg-surface-subtle"><FileCode2 className="size-3.5 text-muted-foreground" aria-hidden="true" /></span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <TruncatedText text={goalSummary} title={task.goal} className="flex-1 text-[13px] font-semibold" />
          </span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{t('codex.elapsed', { duration: elapsedDuration })}</span>
            <span aria-hidden="true">·</span>
            <span className="flex min-w-0 items-center gap-1.5">
              {live
                ? <Badge variant={task.stage === 'waiting' ? 'warning' : 'brand'}>{t(`codex.stage.${task.stage}`)}</Badge>
                : <StatusBadge status={statusKey} label={t(`status.${task.status}`)} />}
              {live ? <TruncatedText text={progressSummary} title={progressLine} /> : null}
            </span>
          </span>
        </span>
        <ChevronDown className={cn('mt-1 size-4 shrink-0 text-muted-foreground transition-transform duration-[200ms] ease-[var(--ease-out)]', !expanded && '-rotate-90')} aria-hidden="true" />
      </button>
      {live ? (
        <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
          <Button type="button" variant="secondary" size="compact" disabled={cancellingTask} onClick={() => { setActionError(''); setCancelDialogOpen(true); }}>
            {t('codex.cancelTask')}
          </Button>
        </div>
      ) : null}
      <Dialog open={cancelDialogOpen} onOpenChange={(open) => { if (!cancellingTask) { setCancelDialogOpen(open); if (open) setActionError(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('codex.cancelConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('codex.cancelConfirmDescription')}</DialogDescription>
          </DialogHeader>
          {actionError ? <p className="text-sm text-danger" role="alert">{actionError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={cancellingTask} onClick={() => setCancelDialogOpen(false)}>{t('codex.cancelKeepRunning')}</Button>
            <Button type="button" variant="secondary" disabled={cancellingTask} aria-busy={cancellingTask} onClick={() => void cancelTask()}>
              {cancellingTask ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" /> : null}
              {cancellingTask ? t('codex.cancellingTask') : t('codex.cancelConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {expanded ? (
        <div id={`project-task-details-${task.id}`} className="wl-fade space-y-4 border-t border-border px-3 pb-3 pt-2.5">
          {pendingQuestion ? (
            <section className="rounded-md border border-warning/30 bg-warning-subtle px-3 py-2.5">
              <h3 className="text-xs font-medium">{t('codex.pendingQuestion')}</h3>
              <MessageResponse content={pendingQuestion.question} enabled className="mt-1 text-[13px]" />
            </section>
          ) : null}
          {task.progressText && !task.result ? <section><h3 className="text-xs font-medium">{t('codex.progress')}</h3><div className="mt-1 max-h-64 overflow-y-auto text-[13px]"><MessageResponse content={task.progressText} enabled /></div></section> : null}
          <dl className="grid gap-3 text-xs sm:grid-cols-2">
            <div className="sm:col-span-2">
              <dt className="font-medium text-muted-foreground">{t('codex.goal')}</dt>
              <dd className="mt-1"><MessageResponse content={task.goal} enabled className="text-xs leading-5" /></dd>
            </div>
            <div className="min-w-0">
              <dt className="font-medium text-muted-foreground">{t('codex.projectDirectory')}</dt>
              <dd className="mt-1 break-all font-mono">{task.projectDirectory}</dd>
            </div>
            {task.worktreePath ? (
              <div className="min-w-0 sm:col-span-2">
                <dt className="font-medium text-muted-foreground">{t('codex.worktree')}</dt>
                <dd className="mt-1 break-all font-mono">
                  {task.worktreePath}
                  {task.worktreeBranch ? `（${task.worktreeBranch}）` : ''}
                  {task.mergeStatus && task.mergeStatus !== 'not_attempted' ? ` · ${t(`codex.mergeStatus.${task.mergeStatus}`)}` : ''}
                  {task.mergeError ? ` · ${task.mergeError}` : ''}
                </dd>
              </div>
            ) : null}
            <div className="min-w-0">
              <dt className="font-medium text-muted-foreground">{t('codex.model')}</dt>
              <dd className="mt-1 break-all font-mono">{task.model}</dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground">{t('codex.executor')}</dt>
              <dd className="mt-1">{executorName}</dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground">{t('codex.status')}</dt>
              <dd className="mt-1"><StatusBadge status={statusKey} label={t(`status.${task.status}`)} /></dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground">{t('codex.createdAt')}</dt>
              <dd className="mt-1">{formatDateTime(task.createdAt, locale)}</dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground">{t('codex.updatedAt')}</dt>
              <dd className="mt-1">{formatDateTime(task.updatedAt, locale)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="font-medium text-muted-foreground">{t('codex.taskId')}</dt>
              <dd className="mt-1 break-all font-mono">{task.id}</dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground">{t('codex.configurationRevision')}</dt>
              <dd className="mt-1 font-mono">{task.configurationRevision}</dd>
            </div>
          </dl>

          <section>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-medium">{t('codex.activities', { count: task.activityCount })}</h3>
              {activitiesTruncated ? <p className="text-[11px] text-muted-foreground">{t('codex.activitiesTruncated', { count: visibleActivities.length })}</p> : !fullActivities && task.activityCount > task.activities.length ? <p className="text-[11px] text-muted-foreground">{t('codex.recentActivities', { count: task.activities.length })}</p> : null}
            </div>
            {activityPhaseSummary.length ? <p className="mt-1 text-[11px] text-muted-foreground">{activityPhaseSummary.join('　/　')}</p> : null}
            {visibleActivities.length > 0 ? (
              <div className="mt-2 space-y-2">
                {(['messages', 'tools', 'lifecycle'] as const).map((groupKey) => {
                  const items = activityGroups[groupKey];
                  return items.length > 0 ? (
                    <CodexActivityGroupSection key={groupKey} groupKey={groupKey} items={items} describeActivity={describeActivity} locale={locale} />
                  ) : null;
                })}
              </div>
            ) : <p className="mt-2 text-xs text-muted-foreground">{t('codex.noActivities')}</p>}
          </section>

          {task.steerQueue.length > 0 ? (
            <section>
              <h3 className="text-xs font-medium text-muted-foreground">{t('codex.steerHistory', { count: task.steerQueue.length })}</h3>
              <ol className="mt-2 space-y-2 rounded-md border border-border bg-surface-subtle/50 p-2">
                {task.steerQueue.map((instruction) => (
                  <li key={instruction.id} className="rounded-sm p-2">
                    <div className="flex items-center justify-between gap-2">
                      <StatusBadge status={instruction.status === 'delivered' ? 'completed' : instruction.status === 'consumed' ? 'completed' : 'queued'} label={t(`codex.steerStatus.${instruction.status}`)} />
                      <span className="text-[11px] text-muted-foreground">{formatDateTime(instruction.createdAt, locale)}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs">{instruction.text}</p>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <section>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-medium">{t('codex.operations', { count: task.operationCount })}</h3>
              {task.operationCount > task.operations.length ? <p className="text-[11px] text-muted-foreground">{t('codex.recentOperations', { count: task.operations.length })}</p> : null}
            </div>
            {operationStatusSummary.length ? <p className="mt-1 text-[11px] text-muted-foreground">{operationStatusSummary.join('　/　')}</p> : null}
            {visibleOperations.length > 0 ? (
              <ol className="mt-2 max-h-64 space-y-2 overflow-y-auto rounded-md border border-border bg-surface-subtle/50 p-2">
                {visibleOperations.map((operation) => {
                  const input = operation.inputSummary;
                  const operationStatusKey = operation.status === 'completed' ? 'completed' : operation.status === 'failed' ? 'failed' : operation.status === 'uncertain' ? 'paused' : 'queued';
                  return (
                    <li key={operation.key} className="rounded-sm p-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 break-words text-xs font-medium">{t('codex.operation.tool', { tool: operation.toolName })}</span>
                        <StatusBadge status={operationStatusKey} label={t(`codex.operationStatus.${operation.status}`)} />
                      </div>
                      {input ? <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{input}</p> : null}
                      {operation.commandExecutionId ? <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{t('codex.operation.command', { id: operation.commandExecutionId })}</p> : null}
                      {operation.failureReason ? <p className="mt-1 max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-xs text-danger">{operation.failureReason}</p> : null}
                      <CodexOperationDisclosure taskId={task.id} operation={operation} />
                    </li>
                  );
                })}
              </ol>
            ) : <p className="mt-2 text-xs text-muted-foreground">{t('codex.noOperations')}</p>}
          </section>

          {task.error ? (
            <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5 text-xs text-danger" role="alert">
              <CircleX className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t('codex.error')}</p>
                <MessageResponse content={task.error} enabled className="mt-1 text-xs leading-5" />
              </div>
            </div>
          ) : null}

          <section>
            <h3 className="text-xs font-medium text-muted-foreground">{t('codex.result')}</h3>
            {task.result ? <MessageResponse content={task.result} enabled /> : <p className="mt-1 text-xs text-muted-foreground">{t('codex.noResult')}</p>}
          </section>

          <Collapsible open={rawOpen} onOpenChange={setRawOpen}>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="secondary" size="compact">
                {rawOpen ? t('codex.hideRawJson') : t('codex.viewRawJson')}
                <ChevronRight className={cn('size-3 transition-transform duration-[120ms]', rawOpen && 'rotate-90')} aria-hidden="true" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-background p-2.5 font-mono text-xs"><code className="whitespace-pre-wrap break-all">{rawJson}</code></pre>
            </CollapsibleContent>
          </Collapsible>
        </div>
      ) : null}
    </article>
  );
}

function ToolCallPanel({ call }: { call: AgentToolCallView }) {
  if (call.projectTask) return <CodexToolCallPanel task={call.projectTask} />;
  return <StandardToolCallPanel call={call} />;
}

function StandardToolCallPanel({ call }: { call: AgentToolCallView }) {
  const { t } = useTranslation('assistant');
  const [expanded, setExpanded] = useState(false);
  const finished = call.status === 'completed' || call.status === 'failed' || call.status === 'cancelled';
  const resource = call.result?.type === 'resource' ? call.result : null;
  const dispatch = call.result?.type === 'dispatch' ? call.result : null;
  const navigation = call.result?.type === 'navigation' ? call.result : null;
  const scriptName = call.scriptPath?.split('/').pop() || call.mcpToolName || t('tool.script');
  // Tool statuses map onto the shared keys; an unknown status falls back to a neutral mark
  // rather than reading as a failure.
  const statusKey: StatusKey = call.status === 'completed' ? 'completed' : call.status === 'running' ? 'running' : call.status === 'failed' ? 'failed' : call.status === 'cancelled' ? 'cancelled' : 'idle';
  return (
    <article className={cn('wl-enter my-2 overflow-hidden rounded-lg border bg-surface shadow-xs transition-[border-color,box-shadow] duration-[200ms]', call.status === 'running' ? 'border-brand/40 wl-live-glow' : call.status === 'failed' ? 'border-danger/30' : 'border-border')} aria-label={t('tool.label')}>
      <button
        type="button"
        className={cn('flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-subtle/70', surfaceInteraction, focusRingInset)}
        aria-expanded={expanded}
        aria-label={expanded ? t('tool.collapse') : t('tool.expand')}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-surface-subtle"><FileCode2 className="size-3.5 text-muted-foreground" aria-hidden="true" /></span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          {call.shell ? 'Shell' : call.projectTask ? t('codex.panel') : call.skillName || t('tool.label')} <span className="font-mono text-xs font-normal text-muted-foreground">/ {scriptName}</span>
        </span>
        {finished && call.exitCode !== null ? <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">{t('tool.exitCode', { code: call.exitCode })}</span> : null}
        <StatusBadge status={statusKey} label={t(`tool.status.${call.status}`)} />
        <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-[200ms] ease-[var(--ease-out)]', !expanded && '-rotate-90')} aria-hidden="true" />
      </button>
      {expanded ? (
        <div className="wl-fade border-t border-border px-3 pb-3 pt-2.5">
          <dl className="grid gap-3 text-xs sm:grid-cols-2">
            <div><dt className="font-medium text-muted-foreground">{t(call.shell ? 'shell.command' : 'tool.script')}</dt><dd className="mt-1 whitespace-pre-wrap break-all font-mono">{call.shell?.command ?? call.scriptPath}</dd></div>
            <div><dt className="font-medium text-muted-foreground">{t('tool.workingDirectory')}</dt><dd className="mt-1 break-all font-mono">{call.workingDirectory}</dd></div>
            <div><dt className="font-medium text-muted-foreground">{t('tool.toolCallId')}</dt><dd className="mt-1 break-all font-mono">{call.id}</dd></div>
            <div><dt className="font-medium text-muted-foreground">{t('tool.commandExecutionId')}</dt><dd className="mt-1 break-all font-mono">{call.commandExecutionId || t('tool.none')}</dd></div>
            <div className="sm:col-span-2">
              <dt className="font-medium text-muted-foreground">{t('tool.arguments')}</dt>
              <dd><pre className="mt-1 overflow-x-auto rounded-md border border-border bg-background p-2.5 font-mono"><code>{JSON.stringify(call.arguments)}</code></pre></dd>
            </div>
          </dl>
          {!call.shell ? <p className="mt-3 flex items-start gap-2 text-[13px] text-warning">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{t('tool.warning')}
          </p> : null}
          {finished ? (
            <div className="mt-3">
              <p className="text-xs font-medium text-muted-foreground">{t('tool.output', { code: call.exitCode ?? t('tool.noExitCode') })}</p>
              <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border bg-background p-2.5 font-mono text-xs"><code>{call.output || t('tool.noOutput')}</code></pre>
            </div>
          ) : null}
          {dispatch ? <Button asChild type="button" variant="link" size="sm" className="mt-2 h-auto px-0"><a href={dispatch.route}>{t('tool.openResource')}<ChevronRight className="size-3.5" aria-hidden="true" /></a></Button> : null}
          {navigation ? <Button asChild type="button" variant="link" size="sm" className="mt-2 h-auto px-0"><a href={navigation.route}>{t('tool.openResource')}<ChevronRight className="size-3.5" aria-hidden="true" /></a></Button> : null}
          {resource ? (
            <Button asChild type="button" variant="link" size="sm" className="mt-2 h-auto px-0">
              <a href={resource.route}>{resource.resourceType === 'provider' ? t('tool.openSecureProvider') : t('tool.openResource')}<ChevronRight className="size-3.5" aria-hidden="true" /></a>
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export { AssistantTurn, buildTimeline, CancelledNote, CodexToolCallPanel, FailureNote, QuestionNote, QueueRows, SummaryDivider, TranscriptSkeleton, UserMessage, WorkflowRunRow };
export type { ActiveWorkflowRun, TimelineEntry };
