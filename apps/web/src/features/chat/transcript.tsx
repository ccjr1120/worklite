import { Link } from '@tanstack/react-router';
import { Ban, ChevronDown, ChevronRight, CircleX, FileCode2, LoaderCircle, MessageSquareText, Play, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentExecutionView, AgentToolCallView, RunView, WorkflowView } from '@worklite/contracts';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { focusRingInset, surfaceInteraction } from '@/components/ui/interaction';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDateTime } from '@/i18n/format';
import type { AppLocale } from '@/i18n/locale';
import { cn } from '@/lib/utils';

type TranscriptMessage = AgentExecutionView['messages'][number];
type TurnSegment = { kind: 'message'; item: TranscriptMessage } | { kind: 'tool'; item: AgentToolCallView };
type Turn = { kind: 'user'; item: TranscriptMessage } | { kind: 'assistant'; segments: TurnSegment[] };

// One Chat turn is one identity block: every assistant message and Skill call
// between two user messages shares a single avatar and content column, so a turn that
// answers, runs a script, and answers again does not read as three speakers.
function groupTurns(execution: AgentExecutionView): Turn[] {
  const ordered: TurnSegment[] = [
    ...execution.messages.map((item) => ({ kind: 'message' as const, occurredAt: item.createdAt, item })),
    ...execution.toolCalls.map((item) => ({ kind: 'tool' as const, occurredAt: item.createdAt, item })),
  ]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .map(({ kind, item }) => ({ kind, item }) as TurnSegment);

  const turns: Turn[] = [];
  for (const segment of ordered) {
    if (segment.kind === 'message' && segment.item.role === 'user') {
      turns.push({ kind: 'user', item: segment.item });
      continue;
    }
    const last = turns[turns.length - 1];
    if (last?.kind === 'assistant') last.segments.push(segment);
    else turns.push({ kind: 'assistant', segments: [segment] });
  }
  return turns;
}

function UserMessage({ message }: { message: TranscriptMessage }) {
  const { t } = useTranslation('assistant');
  return (
    <Message from="user" aria-label={t('speaker.you')}>
      <MessageContent className="max-w-[min(78%,640px)] rounded-md bg-surface-subtle px-3 py-2.5">
        <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.content}</p>
      </MessageContent>
    </Message>
  );
}

function AssistantTurn({ segments, working, markdownEnabled }: {
  segments: TurnSegment[];
  working: boolean;
  markdownEnabled: boolean;
}) {
  const { t } = useTranslation('assistant');
  return (
    <Message from="assistant" aria-label={t('speaker.assistant')}>
      <div className="flex w-full items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface">
          <MessageSquareText className="size-4 text-muted-foreground" aria-hidden="true" />
        </span>
        <MessageContent className="min-w-0 flex-1 pt-0.5">
          {segments.map((segment) => segment.kind === 'message'
            ? <MessageResponse key={segment.item.id} content={segment.item.content} enabled={markdownEnabled} />
            : <ToolCallPanel key={segment.item.id} call={segment.item} />)}
          {working ? <WorkingNote /> : null}
        </MessageContent>
      </div>
    </Message>
  );
}

function WorkingNote() {
  const { t } = useTranslation('assistant');
  return (
    <p className="flex items-center gap-2 py-1.5 text-[13px] text-muted-foreground" role="status">
      <LoaderCircle className="size-4 shrink-0 text-brand motion-safe:animate-spin" aria-hidden="true" />
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
    <div className="my-3 border-l-2 border-brand pl-3" role="status">
      <p className="text-sm font-medium">{question.question}</p>
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
    <p className="flex items-center gap-2 py-3 text-[13px] text-muted-foreground" role="status">
      <Ban className="size-4 shrink-0" aria-hidden="true" />
      {t('execution.cancelled')}
    </p>
  );
}

function FailureNote({ execution, message, onRetry, retryDisabled, locale }: { execution: AgentExecutionView | null; message: string; onRetry: () => void; retryDisabled: boolean; locale: AppLocale }) {
  const { t } = useTranslation('assistant');
  if (!execution) return null;
  return (
    <div className="flex items-start gap-2 py-3 text-[13px] text-danger" role="alert">
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
    <section className="mt-3 rounded-md border border-border bg-surface-subtle p-3" role="status" aria-label={t('queue.title', { count: queued.length })}>
      <p className="text-xs font-medium text-muted-foreground">{t('queue.title', { count: queued.length })}</p>
      <ol className="mt-2 space-y-1.5">
        {queued.map((item, index) => (
          <li key={item.id} className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground">{index + 1}</span>
            <span className="min-w-0 flex-1 break-words text-[13px] leading-5">{item.text}</span>
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
  const statusKey = run.status === 'succeeded' ? 'completed' : run.status === 'timed_out' ? 'failed' : run.status;
  const failure = run.nodeRuns?.find((nodeRun) => nodeRun.status === 'failed')?.error;
  return (
    <div className="my-3 rounded-md border border-border bg-surface-subtle p-3" role="status">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface">
          <Play className={cn('size-4 text-muted-foreground', (run.status === 'queued' || run.status === 'running') && 'text-brand motion-safe:animate-pulse')} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{workflow.name}</span>
            <Badge variant={run.status === 'failed' || run.status === 'timed_out' ? 'danger' : run.status === 'paused' ? 'warning' : 'neutral'}>
              {run.status === 'waiting_for_input' ? t('workflowRun.waitingForConfirmation') : t(`status.${statusKey}`)}
            </Badge>
          </div>
          <p className="mt-1 break-words text-[13px] text-muted-foreground">{input || t('workflowRun.emptyInput')}</p>
          {run.currentStep ? <p className="mt-1 text-xs text-muted-foreground">{t('workflowRun.currentStep', { step: run.currentStep })}</p> : null}
          {run.status === 'waiting_for_input' ? <p className="mt-2 text-xs text-muted-foreground">{t('workflowRun.openRunHistory')}</p> : null}
          {failure ? <p className="mt-2 text-xs text-danger">{failure}</p> : null}
          {run.artifacts && run.artifacts.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {run.artifacts.map((artifact) => (
                <Link key={artifact.id} to="/artifacts/$artifactId" params={{ artifactId: artifact.id }} className="text-xs font-medium text-brand underline-offset-2 hover:underline">
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

function ToolCallPanel({ call }: { call: AgentToolCallView }) {
  const { t } = useTranslation('assistant');
  const [expanded, setExpanded] = useState(false);
  const finished = call.status === 'completed' || call.status === 'failed' || call.status === 'cancelled';
  const resource = call.result?.type === 'resource' ? call.result : null;
  const dispatch = call.result?.type === 'dispatch' ? call.result : null;
  const navigation = call.result?.type === 'navigation' ? call.result : null;
  const scriptName = call.codexTask?.model || call.scriptPath?.split('/').pop() || call.mcpToolName || t('tool.script');
  const variant = call.status === 'completed' ? 'success' : call.status === 'running' ? 'brand' : call.status === 'cancelled' ? 'neutral' : 'danger';
  return (
    <article className="my-2 border-l-2 border-warning bg-surface-subtle" aria-label={t('tool.label')}>
      <button
        type="button"
        className={cn('flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left hover:bg-background/50', surfaceInteraction, focusRingInset)}
        aria-expanded={expanded}
        aria-label={expanded ? t('tool.collapse') : t('tool.expand')}
        onClick={() => setExpanded((value) => !value)}
      >
        <FileCode2 className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {call.shell ? 'Shell' : call.codexTask ? 'Codex' : call.skillName || t('tool.label')} <span className="font-mono text-xs font-normal text-muted-foreground">/ {scriptName}</span>
        </span>
        {finished && call.exitCode !== null ? <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{t('tool.exitCode', { code: call.exitCode })}</span> : null}
        <Badge variant={variant}>{t(`tool.status.${call.status}`)}</Badge>
        {expanded ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
      </button>
      {expanded ? (
        <div className="border-t border-border px-3 pb-3 pt-2.5">
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
          {call.codexTask ? <div className="mt-3">
            <p className="text-xs font-medium">{call.codexTask.goal}</p>
            <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-border bg-background p-2.5 font-mono text-xs"><code>{JSON.stringify(call.codexTask, null, 2)}</code></pre>
          </div> : null}
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

export { AssistantTurn, CancelledNote, FailureNote, groupTurns, QuestionNote, QueueRows, TranscriptSkeleton, UserMessage, WorkflowRunRow };
