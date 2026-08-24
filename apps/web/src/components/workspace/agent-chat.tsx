import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  ArrowUp,
  Blocks,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleDashed,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  MessageSquareText,
  PanelRightOpen,
  Server,
  ShieldAlert,
  UserRound,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useMediaQuery } from '@/hooks/use-media-query';
import { cn } from '@/lib/utils';

type ResourceKind = 'provider' | 'skill' | 'mcp' | 'agent';
type OperationStatus = 'needs_input' | 'ready' | 'running' | 'completed' | 'failed';

type AssistantOperation = {
  id: string;
  resource: ResourceKind;
  status: OperationStatus;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

type AssistantSession = {
  draft: string;
  messages: ChatMessage[];
  operations: AssistantOperation[];
  preparing: boolean;
  applying: boolean;
  announcement: string;
};

type AssistantView = 'chat' | 'proposal';

type AssistantSessionStore = {
  sessions: Record<string, AssistantSession>;
  updateSession: (teamSlug: string, update: (current: AssistantSession) => AssistantSession) => void;
};

type AssistantStarter = {
  kind: ResourceKind;
  icon: typeof Bot;
};

const EMPTY_SESSION: AssistantSession = {
  draft: '',
  messages: [],
  operations: [],
  preparing: false,
  applying: false,
  announcement: '',
};

const useAssistantSessions = create<AssistantSessionStore>((set) => ({
  sessions: {},
  updateSession: (teamSlug, update) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [teamSlug]: update(state.sessions[teamSlug] ?? EMPTY_SESSION),
      },
    })),
}));

const RESOURCE_ORDER: ResourceKind[] = ['provider', 'skill', 'mcp', 'agent'];

const RESOURCE_ICONS = {
  provider: KeyRound,
  skill: Blocks,
  mcp: Server,
  agent: Bot,
} satisfies Record<ResourceKind, typeof Bot>;

const STATUS_CONFIG = {
  needs_input: { variant: 'warning', icon: ShieldAlert },
  ready: { variant: 'info', icon: CircleDashed },
  running: { variant: 'brand', icon: LoaderCircle },
  completed: { variant: 'success', icon: CheckCircle2 },
  failed: { variant: 'danger', icon: XCircle },
} as const;

function AgentChat({ teamSlug }: { teamSlug: string }) {
  const { t } = useTranslation(['assistant', 'workspace']);
  const isWide = useMediaQuery('(min-width: 1280px)');
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location });
  const sessions = useAssistantSessions((state) => state.sessions);
  const updateSession = useAssistantSessions((state) => state.updateSession);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<AssistantView>('chat');
  const shellRef = useRef<HTMLDivElement>(null);
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const proposalHeadingRef = useRef<HTMLHeadingElement>(null);
  const session = sessions[teamSlug] ?? EMPTY_SESSION;
  const isHome = location.pathname === `/${teamSlug}/home`;
  const assistantRequested = isHome && (location.search as { assistant?: unknown }).assistant === 'open';
  const showSideInspector = isHome && isWide;

  const hasProposal = session.operations.length > 0;
  const hasSecureRequirement = session.operations.some((operation) => operation.status === 'needs_input');
  const completedCount = session.operations.filter((operation) => operation.status === 'completed').length;
  const allCompleted = hasProposal && completedCount === session.operations.length;

  const starters = useMemo<AssistantStarter[]>(
    () => [
      { kind: 'provider', icon: KeyRound },
      { kind: 'skill', icon: Blocks },
      { kind: 'mcp', icon: Server },
      { kind: 'agent', icon: Bot },
    ],
    [],
  );

  useEffect(() => {
    setOpen(assistantRequested);
    setView('chat');
  }, [assistantRequested, location.pathname, teamSlug]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!shellRef.current?.contains(event.target as Node)) {
        handleOpenChange(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleOpenChange(false);
      }
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open, assistantRequested, teamSlug]);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }, [open, session.messages, session.preparing, view]);

  useEffect(() => {
    if (!open || !hasProposal || (!showSideInspector && view !== 'proposal')) {
      return;
    }

    const frame = window.requestAnimationFrame(() => proposalHeadingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [hasProposal, open, showSideInspector, view]);

  function buildOperations(prompt: string): AssistantOperation[] {
    const normalized = prompt.toLowerCase();
    const selected = RESOURCE_ORDER.filter((resource) => {
      if (resource === 'provider') return /provider|model|openai|anthropic/.test(normalized);
      if (resource === 'skill') return /skill|instruction|triag/.test(normalized);
      if (resource === 'mcp') return /mcp|tool|server|customer data/.test(normalized);
      return /agent|coordinator|assistant/.test(normalized);
    });
    const resources: ResourceKind[] = selected.length > 0 ? selected : ['agent'];

    return resources.map((resource, index) => ({
      id: `${resource}-${Date.now()}-${index}`,
      resource,
      status: resource === 'provider' ? 'needs_input' : 'ready',
    }));
  }

  function prepareProposal(prompt: string) {
    const value = prompt.trim();
    if (!value || session.preparing || session.applying) {
      return;
    }

    const ownerTeamSlug = teamSlug;
    setOpen(true);
    setView('chat');
    updateSession(ownerTeamSlug, (current) => ({
      ...current,
      draft: '',
      operations: [],
      preparing: true,
      announcement: '',
      messages: [...current.messages, { id: `user-${Date.now()}`, role: 'user', content: value }],
    }));

    window.setTimeout(() => {
      const nextOperations = buildOperations(value);
      const needsInput = nextOperations.some((operation) => operation.status === 'needs_input');
      updateSession(ownerTeamSlug, (current) => ({
        ...current,
        operations: nextOperations,
        preparing: false,
        announcement: t('assistant:announcements.proposalReady'),
        messages: [
          ...current.messages,
          {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: needsInput ? t('assistant:messages.proposalNeedsInput') : t('assistant:messages.proposalReady'),
          },
        ],
      }));
    }, 650);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    prepareProposal(session.draft);
  }

  async function applyOperations() {
    if (!hasProposal || hasSecureRequirement || session.applying) {
      return;
    }

    const ownerTeamSlug = teamSlug;
    const ownerOperations = session.operations;
    updateSession(ownerTeamSlug, (current) => ({
      ...current,
      applying: true,
      announcement: t('assistant:announcements.applying'),
    }));

    for (const operation of ownerOperations) {
      updateSession(ownerTeamSlug, (current) => ({
        ...current,
        operations: current.operations.map((item) =>
          item.id === operation.id ? { ...item, status: 'running' } : item,
        ),
      }));
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      updateSession(ownerTeamSlug, (current) => ({
        ...current,
        operations: current.operations.map((item) =>
          item.id === operation.id ? { ...item, status: 'completed' } : item,
        ),
      }));
    }

    updateSession(ownerTeamSlug, (current) => ({
      ...current,
      applying: false,
      announcement: t('assistant:announcements.completed'),
      messages: [
        ...current.messages,
        { id: `assistant-${Date.now()}`, role: 'assistant', content: t('assistant:messages.completed') },
      ],
    }));
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) {
      setView('chat');
      return;
    }

    if (assistantRequested) {
      void navigate({
        to: '/$teamSlug/home',
        params: { teamSlug },
        search: {},
        replace: true,
      });
    }
  }

  const minimizedStatus = session.preparing
    ? { icon: LoaderCircle, label: t('assistant:minimized.preparing'), animated: true }
    : session.applying
      ? {
          icon: LoaderCircle,
          label: t('assistant:minimized.running', { completed: completedCount, total: session.operations.length }),
          animated: true,
        }
      : allCompleted
        ? { icon: CheckCircle2, label: t('assistant:minimized.completed', { count: session.operations.length }), animated: false }
        : hasSecureRequirement
          ? { icon: ShieldAlert, label: t('assistant:minimized.needsInput'), animated: false }
          : hasProposal
            ? { icon: CircleDashed, label: t('assistant:minimized.ready', { count: session.operations.length }), animated: false }
            : session.messages.length > 0
              ? { icon: MessageSquareText, label: t('assistant:minimized.openConversation'), animated: false }
              : null;
  const MinimizedStatusIcon = minimizedStatus?.icon;

  const panelHeight = 'h-[min(680px,calc(100vh-120px))]';

  return (
    <div
      ref={shellRef}
      className={cn(
        'pointer-events-none absolute z-30',
        'inset-x-3 bottom-3 sm:inset-x-6 sm:bottom-6',
      )}
    >
      <div
        className={cn(
          'pointer-events-auto ml-auto flex w-full flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-md',
          'w-full',
        )}
      >
        <div
          id="assistant-panel-content"
          aria-hidden={!open}
          inert={!open}
          className={cn(
            'overflow-hidden transition-[height,opacity,transform] duration-[200ms] ease-out motion-reduce:transition-none',
            open ? cn(panelHeight, 'translate-y-0 opacity-100') : 'pointer-events-none h-0 translate-y-2 opacity-0',
          )}
        >
          <div className="h-full min-h-0">
            {showSideInspector ? (
              <div className="flex h-full min-h-0">
                <section className="flex min-w-0 flex-1 flex-col" aria-labelledby="assistant-panel-title">
                  <AssistantHeader onMinimize={() => handleOpenChange(false)} />
                  <ConversationPane
                    messages={session.messages}
                    preparing={session.preparing}
                    starters={starters}
                    conversationEndRef={conversationEndRef}
                    onStarter={(kind) => prepareProposal(t(`assistant:starters.${kind}.prompt`))}
                  />
                </section>
                <aside className="w-[380px] shrink-0 border-l border-border bg-surface" aria-label={t('assistant:proposal.title')}>
                  <ProposalInspector
                    operations={session.operations}
                    applying={session.applying}
                    teamSlug={teamSlug}
                    headingRef={proposalHeadingRef}
                    onApply={() => void applyOperations()}
                  />
                </aside>
              </div>
            ) : (
              <Tabs value={view} onValueChange={(value) => setView(value as AssistantView)} className="h-full gap-0">
                <AssistantHeader onMinimize={() => handleOpenChange(false)} />
                <TabsList className="mx-4 mt-3 grid shrink-0 grid-cols-2">
                  <TabsTrigger value="chat">{t('assistant:views.chat')}</TabsTrigger>
                  <TabsTrigger value="proposal" disabled={!hasProposal}>
                    {t('assistant:views.proposal')}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="chat" className="m-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col">
                  <ConversationPane
                    messages={session.messages}
                    preparing={session.preparing}
                    starters={starters}
                    conversationEndRef={conversationEndRef}
                    onStarter={(kind) => prepareProposal(t(`assistant:starters.${kind}.prompt`))}
                  />
                </TabsContent>
                <TabsContent value="proposal" className="m-0 min-h-0 flex-1 overflow-hidden">
                  <ProposalInspector
                    operations={session.operations}
                    applying={session.applying}
                    teamSlug={teamSlug}
                    headingRef={proposalHeadingRef}
                    onApply={() => void applyOperations()}
                  />
                </TabsContent>
              </Tabs>
            )}
          </div>
        </div>

        {!open && minimizedStatus && MinimizedStatusIcon ? (
          <button
            type="button"
            className="flex min-h-8 w-full items-center gap-2 border-b border-border px-3 text-left text-[13px] text-muted-foreground transition-colors duration-[120ms] hover:bg-surface-subtle hover:text-foreground"
            onClick={() => handleOpenChange(true)}
          >
            <MinimizedStatusIcon
              className={cn('size-4 shrink-0 text-brand', minimizedStatus.animated && 'motion-safe:animate-spin')}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate">{minimizedStatus.label}</span>
            <ChevronUp className="size-4 shrink-0" aria-hidden="true" />
          </button>
        ) : null}

        <form className="flex items-center gap-2 p-2" onSubmit={onSubmit}>
          <label htmlFor="assistant-message" className="flex shrink-0 items-center gap-2 text-[13px] font-medium">
            <MessageSquareText className="size-4 text-brand" aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">{t('assistant:title')}</span>
          </label>
          <Input
            id="assistant-message"
            value={session.draft}
            onChange={(event) =>
              updateSession(teamSlug, (current) => ({ ...current, draft: event.target.value }))
            }
            onFocus={() => handleOpenChange(true)}
            placeholder={t('assistant:composer.placeholder')}
            className="min-w-0 flex-1"
            aria-controls="assistant-panel-content"
            aria-expanded={open}
            disabled={session.preparing || session.applying}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className="flex size-8 shrink-0 items-center justify-center text-muted-foreground"
                aria-label={t('assistant:composer.secure')}
              >
                <LockKeyhole className="size-3.5" aria-hidden="true" />
              </span>
            </TooltipTrigger>
            <TooltipContent>{t('assistant:composer.secure')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="submit"
                size="icon-compact"
                aria-label={t('assistant:composer.send')}
                disabled={!session.draft.trim() || session.preparing || session.applying}
              >
                <ArrowUp className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('assistant:composer.send')}</TooltipContent>
          </Tooltip>
        </form>
      </div>
      <p className="sr-only" aria-live="polite">{session.announcement}</p>
    </div>
  );
}

function AssistantHeader({ onMinimize }: { onMinimize: () => void }) {
  const { t } = useTranslation('assistant');

  return (
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
      <div className="min-w-0">
        <h2 id="assistant-panel-title" className="text-base font-semibold">{t('title')}</h2>
        <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{t('description')}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="neutral" className="hidden shrink-0 sm:inline-flex">
              <CircleDashed className="size-3" aria-hidden="true" />
              {t('localSession')}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{t('localSessionDetail')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon-compact" aria-label={t('minimized.minimize')} onClick={onMinimize}>
              <ChevronDown className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('minimized.minimize')}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

function ConversationPane({
  messages,
  preparing,
  starters,
  conversationEndRef,
  onStarter,
}: {
  messages: ChatMessage[];
  preparing: boolean;
  starters: AssistantStarter[];
  conversationEndRef: RefObject<HTMLDivElement | null>;
  onStarter: (kind: ResourceKind) => void;
}) {
  const { t } = useTranslation('assistant');

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
      <div className="mx-auto flex min-h-full w-full max-w-[820px] flex-col py-5">
        {messages.length === 0 ? (
          <div className="my-auto py-6">
            <div className="mb-5 flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-md border border-border bg-surface" aria-hidden="true">
                <MessageSquareText className="size-[18px] text-brand" />
              </span>
              <div>
                <p className="text-sm font-semibold">{t('starters.title')}</p>
                <p className="mt-0.5 text-[13px] text-muted-foreground">{t('messages.welcome')}</p>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {starters.map((starter) => {
                const Icon = starter.icon;
                return (
                  <button
                    key={starter.kind}
                    type="button"
                    className="group flex min-h-[72px] items-center gap-3 rounded-md border border-border bg-surface p-3 text-left transition-colors duration-[120ms] hover:bg-surface-subtle disabled:opacity-50"
                    onClick={() => onStarter(starter.kind)}
                    disabled={preparing}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-subtle">
                      <Icon className="size-4 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{t(`starters.${starter.kind}.title`)}</span>
                      <span className="mt-0.5 block text-[13px] leading-5 text-muted-foreground">
                        {t(`starters.${starter.kind}.description`)}
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex flex-col">
            {messages.map((message) => (
              <MessageRow key={message.id} message={message} />
            ))}
            {preparing ? (
              <div className="flex gap-3 border-b border-border py-5" role="status">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface">
                  <LoaderCircle className="size-4 text-brand motion-safe:animate-spin" aria-hidden="true" />
                </span>
                <div className="min-w-0 pt-0.5">
                  <p className="text-xs font-medium text-muted-foreground">{t('speaker.assistant')}</p>
                  <p className="mt-1 text-sm">{t('composer.sending')}</p>
                </div>
              </div>
            ) : null}
          </div>
        )}
        <div ref={conversationEndRef} />
      </div>
    </div>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const { t } = useTranslation('assistant');
  const isUser = message.role === 'user';
  const Icon = isUser ? UserRound : MessageSquareText;

  return (
    <article className="flex gap-3 border-b border-border py-5">
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-md border border-border',
          isUser ? 'bg-surface-subtle' : 'bg-surface',
        )}
        aria-hidden="true"
      >
        <Icon className={cn('size-4', isUser ? 'text-muted-foreground' : 'text-brand')} />
      </span>
      <div className="min-w-0 pt-0.5">
        <p className="text-xs font-medium text-muted-foreground">{t(isUser ? 'speaker.you' : 'speaker.assistant')}</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{message.content}</p>
      </div>
    </article>
  );
}

function ProposalInspector({
  operations,
  applying,
  teamSlug,
  headingRef,
  onApply,
}: {
  operations: AssistantOperation[];
  applying: boolean;
  teamSlug: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onApply: () => void;
}) {
  const { t } = useTranslation('assistant');
  const hasOperations = operations.length > 0;
  const hasSecureRequirement = operations.some((operation) => operation.status === 'needs_input');
  const allCompleted = hasOperations && operations.every((operation) => operation.status === 'completed');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border px-4 py-4">
        <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
          {t('proposal.title')}
        </h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {hasOperations ? t('proposal.operationCount', { count: operations.length }) : t('proposal.description')}
        </p>
      </header>

      {!hasOperations ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <span className="flex size-10 items-center justify-center rounded-md border border-border bg-surface-subtle" aria-hidden="true">
            <PanelRightOpen className="size-[18px] text-muted-foreground" />
          </span>
          <h3 className="mt-3 text-sm font-semibold">{t('proposal.emptyTitle')}</h3>
          <p className="mt-1 max-w-[260px] text-[13px] leading-5 text-muted-foreground">{t('proposal.emptyDescription')}</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <dl className="grid grid-cols-2 gap-3 border-b border-border bg-surface-subtle px-4 py-3 text-[13px]">
            <div>
              <dt className="text-xs text-muted-foreground">{t('proposal.scope')}</dt>
              <dd className="mt-1 font-medium">{t('proposal.teamScope')}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('proposal.execution')}</dt>
              <dd className="mt-1 font-medium">{t('proposal.operationCount', { count: operations.length })}</dd>
            </div>
          </dl>
          <div className="divide-y divide-border">
            {operations.map((operation, index) => (
              <OperationRow key={operation.id} operation={operation} position={index + 1} teamSlug={teamSlug} />
            ))}
          </div>
        </div>
      )}

      {hasOperations ? (
        <footer className="shrink-0 border-t border-border p-4">
          {hasSecureRequirement ? (
            <Button asChild className="w-full">
              <Link to="/$teamSlug/model-providers" params={{ teamSlug }}>
                <KeyRound className="size-4" />
                {t('proposal.openSecureSettings')}
              </Link>
            </Button>
          ) : (
            <Button className="w-full" onClick={onApply} disabled={applying || allCompleted}>
              {applying ? <LoaderCircle className="size-4 motion-safe:animate-spin" /> : <CheckCircle2 className="size-4" />}
              {applying ? t('proposal.applying') : allCompleted ? t('proposal.applied') : t('proposal.apply')}
            </Button>
          )}
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {hasSecureRequirement ? t('proposal.blocked') : t('proposal.executionDetail')}
          </p>
        </footer>
      ) : null}
    </div>
  );
}

function OperationRow({
  operation,
  position,
  teamSlug,
}: {
  operation: AssistantOperation;
  position: number;
  teamSlug: string;
}) {
  const { t } = useTranslation('assistant');
  const ResourceIcon = RESOURCE_ICONS[operation.resource];
  const status = STATUS_CONFIG[operation.status];
  const StatusIcon = status.icon;
  const resourceHref = getResourceHref(teamSlug, operation.resource);

  return (
    <article className="px-4 py-4">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-subtle" aria-hidden="true">
          <ResourceIcon className="size-4 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">
              {position}. {t(`resources.${operation.resource}`)}
            </p>
            <Badge variant={status.variant}>
              <StatusIcon className={cn('size-3', operation.status === 'running' && 'motion-safe:animate-spin')} aria-hidden="true" />
              {t(`status.${operation.status}`)}
            </Badge>
          </div>
          <h3 className="mt-2 break-words text-sm font-semibold">{t(`operations.${operation.resource}.title`)}</h3>
          <p className="mt-0.5 text-[13px] font-medium">{t(`operations.${operation.resource}.action`)}</p>
          <p className="mt-2 break-words text-[13px] leading-5 text-muted-foreground">
            {t(`operations.${operation.resource}.summary`)}
          </p>
          {operation.status === 'completed' ? (
            <Button asChild variant="link" size="sm" className="mt-2 h-auto px-0">
              <a href={resourceHref}>
                {t('proposal.openResource')}
                <ChevronRight className="size-3.5" />
              </a>
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function getResourceHref(teamSlug: string, resource: ResourceKind) {
  if (resource === 'provider') return `/${teamSlug}/model-providers`;
  if (resource === 'skill') return `/${teamSlug}/skills/new`;
  if (resource === 'mcp') return `/${teamSlug}/mcp-servers/new`;
  return `/${teamSlug}/agents/new`;
}

export { AgentChat };
