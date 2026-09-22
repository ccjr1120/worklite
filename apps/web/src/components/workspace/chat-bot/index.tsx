import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Bot, ChevronDown, ChevronRight, LoaderCircle, MessageSquareText, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentExecutionView, AgentToolCallView, RunView, WorkflowView } from '@worklite/contracts';
import { ApiError, api, parseAgentExecutionEvent } from '@/api/client';
import { useAgentQuery, useMcpServersQuery, useModelProvidersQuery, useWorkflowsQuery } from '@/api/queries';
import { Conversation, ConversationContent } from '@/components/ai-elements/conversation';
import { useLocale } from '@/components/locale-provider';
import { useTheme } from '@/components/theme-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { focusRing, focusRingInset, surfaceInteraction } from '@/components/ui/interaction';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { queryClient } from '@/lib/query-client';
import { cn } from '@/lib/utils';
import { Composer, SLASH_COMMANDS, type SlashCommand } from './composer';
import { Configuration } from './configuration';
import { downloadExecutionLog } from './execution-log';
import { SessionSwitcher, type ArchivedExecution } from './session-switcher';
import { AssistantTurn, CancelledNote, FailureNote, groupTurns, QuestionNote, QueueRows, StarterPane, TranscriptSkeleton, UserMessage, WorkflowRunRow } from './transcript';

const CHAT_BOT_AGENT_ID = 'agt_system_helper_chat';
const HISTORY_LIMIT = 20;
const INCOMPLETE_SKILL_REQUEST = 'The model returned an incomplete Skill request. Its JSON ended before the request was complete.';
const INVALID_SKILL_REQUEST = 'The model returned an invalid Skill request. Its arguments could not be parsed or did not match the required structure.';
const GENERIC_AGENT_ERROR = 'Chat Bot could not complete this turn. Check its provider configuration and try again.';
const AGENT_TURN_ERROR = 'Chat Bot could not complete this turn.';
const SKILL_EXECUTION_ERROR = 'The Skill script could not be completed.';
const RESTARTED_AGENT_ERROR = 'The API restarted before this Chat Bot turn completed.';

type StoredExecutionState = { activeId: string | null; archived: ArchivedExecution[] };
type QueuedMessage = { id: string; text: string };
type ActiveWorkflowRun = { workflow: WorkflowView; run: RunView; input: string };

function storageKey(workspaceSlug: string) {
  return `worklite.chat-bot.executions.${workspaceSlug}`;
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

function apiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
}

function ChatBot({ workspaceSlug }: { workspaceSlug: string }) {
  const { t } = useTranslation(['assistant', 'common']);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const locationSearch = useRouterState({ select: (state) => state.location.search as Record<string, unknown> });
  const navigate = useNavigate();
  const agentQuery = useAgentQuery(workspaceSlug, CHAT_BOT_AGENT_ID);
  const providersQuery = useModelProvidersQuery(workspaceSlug);
  const mcpServersQuery = useMcpServersQuery(workspaceSlug);
  const workflowsQuery = useWorkflowsQuery(workspaceSlug);
  const { applyAppearancePreference } = useTheme();
  const { locale } = useLocale();
  const initialState = useMemo(() => readStoredState(workspaceSlug), [workspaceSlug]);
  const [activeId, setActiveId] = useState<string | null>(initialState.activeId);
  const [archived, setArchived] = useState<ArchivedExecution[]>(initialState.archived);
  const [execution, setExecution] = useState<AgentExecutionView | null>(null);
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowView | null>(null);
  const [workflowRun, setWorkflowRun] = useState<ActiveWorkflowRun | null>(null);
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [panelView, setPanelView] = useState<'chat' | 'configuration'>(initialState.activeId ? 'chat' : 'configuration');
  const [configSelection, setConfigSelection] = useState('');
  const [selectedMcpServerIds, setSelectedMcpServerIds] = useState<string[]>([]);
  const [configSaving, setConfigSaving] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingExecution, setLoadingExecution] = useState(Boolean(initialState.activeId));
  const [error, setError] = useState('');
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [activeValue, setActiveValue] = useState('');
  const [mainConnectionState, setMainConnectionState] = useState<'connected' | 'reconnecting'>('connected');
  const [floatingPosition, setFloatingPosition] = useState({ right: 24, bottom: 24 });
  const chatSurfaceRef = useRef<HTMLDivElement>(null);
  const floatingContainerRef = useRef<HTMLDivElement>(null);
  const floatingDragRef = useRef<{ startX: number; startY: number; right: number; bottom: number; moved: boolean } | null>(null);
  const suppressFloatingClickRef = useRef(false);
  const currentPathRef = useRef(pathname);
  const appliedResultIdsRef = useRef(new Set<string>());
  const mainRequestGenerationRef = useRef(0);
  const escapeRef = useRef<() => boolean>(() => false);
  const isConfigured = Boolean(agentQuery.data?.providerId && agentQuery.data?.model);

  useEffect(() => {
    if (!agentQuery.data) return;
    setConfigSelection(agentQuery.data.providerId && agentQuery.data.model ? `${agentQuery.data.providerId}::${agentQuery.data.model}` : '');
    setSelectedMcpServerIds(agentQuery.data.mcpServers.map((server) => server.id));
    if (agentQuery.data.providerId && agentQuery.data.model) setPanelView('chat');
  }, [agentQuery.data]);

  const saveConfiguration = async (selection: string, mcpServerIds: string[]) => {
    if (!selection || configSaving) return;
    const separator = selection.indexOf('::');
    if (separator < 0) return;
    setConfigSaving(true);
    try {
      await api.updateAgent(workspaceSlug, CHAT_BOT_AGENT_ID, { providerId: selection.slice(0, separator), model: selection.slice(separator + 2), mcpServerIds });
      await queryClient.invalidateQueries({ queryKey: ['agent', CHAT_BOT_AGENT_ID] });
      setPanelView('chat');
    } finally { setConfigSaving(false); }
  };

  const visibleExecution = execution;
  const connectionState = mainConnectionState;
  const running = visibleExecution?.status === 'running';
  const isHome = pathname === '/home';
  const waitingForInput = visibleExecution?.status === 'waiting_for_input';
  const workflowRunning = workflowRun?.run.status === 'queued' || workflowRun?.run.status === 'running' || workflowRun?.run.status === 'paused' || workflowRun?.run.status === 'waiting_for_input';
  const mentionMatch = !selectedWorkflow && !workflowRunning ? /(?:^|\s)@([^\s@]*)$/.exec(draft) : null;
  const mentionQuery = mentionMatch?.[1]?.toLocaleLowerCase() ?? '';
  const eligibleWorkflows = useMemo(() => (workflowsQuery.data ?? []).filter((workflow) => workflow.state === 'published' && workflow.latestVersionId), [workflowsQuery.data]);
  const mentionMatches = mentionMatch && !mentionDismissed
    ? eligibleWorkflows.filter((workflow) => workflow.name.toLocaleLowerCase().includes(mentionQuery))
    : [];
  const mentionMenuOpen = Boolean(mentionMatch && !mentionDismissed);
  const slashQuery = draft.trimStart().toLowerCase();
  const commandMatches = !selectedWorkflow && !mentionMenuOpen && !workflowRunning && slashQuery.startsWith('/') && !slashDismissed
    ? SLASH_COMMANDS.filter((command) => command.value.startsWith(slashQuery))
    : [];
  const commandMenuOpen = !selectedWorkflow && !mentionMenuOpen && !workflowRunning && slashQuery.startsWith('/') && !slashDismissed;

  const executionError = visibleExecution?.errorCode === 'incomplete_tool_request' || visibleExecution?.error === INCOMPLETE_SKILL_REQUEST
    ? t('assistant:execution.incompleteSkillRequest')
    : visibleExecution?.errorCode === 'invalid_tool_request' || visibleExecution?.error === INVALID_SKILL_REQUEST
      ? t('assistant:execution.invalidSkillRequest')
      : visibleExecution?.errorCode === 'provider' || visibleExecution?.error === GENERIC_AGENT_ERROR
        ? t('assistant:execution.providerRequestFailed')
        : visibleExecution?.errorCode === 'invalid_request' || visibleExecution?.error === AGENT_TURN_ERROR
          ? t('assistant:execution.requestFailed')
          : visibleExecution?.errorCode === 'skill' || visibleExecution?.error === SKILL_EXECUTION_ERROR
            ? t('assistant:execution.skillFailed')
            : visibleExecution?.errorCode === 'restarted' || visibleExecution?.error === RESTARTED_AGENT_ERROR
              ? t('assistant:execution.restarted')
              : visibleExecution?.error ?? '';

  const applyCompletedResult = useCallback(async (call: AgentToolCallView) => {
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
      return;
    }
    if (result.type === 'navigation') void navigate({ to: result.route as never });
  }, [applyAppearancePreference, navigate]);

  const applyCompletedResults = useCallback(async (next: AgentExecutionView) => {
    for (const call of next.toolCalls) {
      if (call.status !== 'completed' || appliedResultIdsRef.current.has(call.id)) continue;
      appliedResultIdsRef.current.add(call.id);
      await applyCompletedResult(call);
    }
  }, [applyCompletedResult]);

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
    const generation = ++mainRequestGenerationRef.current;
    let retryTimer: number | undefined;
    appliedResultIdsRef.current.clear();
    if (!activeId) {
      setExecution(null);
      setLoadingExecution(false);
      setMainConnectionState('connected');
      return;
    }
    setLoadingExecution(true);
    let delay = 1_500;
    const load = async () => {
      if (cancelled || generation !== mainRequestGenerationRef.current) return;
      try {
        const next = await api.agentExecution(workspaceSlug, CHAT_BOT_AGENT_ID, activeId);
        if (cancelled || generation !== mainRequestGenerationRef.current) return;
        for (const call of next.toolCalls) if (call.status === 'completed') appliedResultIdsRef.current.add(call.id);
        setMainConnectionState('connected');
        setError('');
        setExecution(next);
      } catch (loadError) {
        if (cancelled || generation !== mainRequestGenerationRef.current) return;
        if (loadError instanceof ApiError && loadError.status < 500) {
          setMainConnectionState('connected');
          setError(apiErrorMessage(loadError, t('assistant:execution.loadFailed')));
          return;
        }
        setMainConnectionState('reconnecting');
        retryTimer = window.setTimeout(load, delay);
        delay = Math.min(delay * 2, 12_000);
      } finally {
        if (!cancelled) setLoadingExecution(false);
      }
    };
    void load();
    return () => { cancelled = true; if (retryTimer !== undefined) window.clearTimeout(retryTimer); };
  }, [activeId, t, workspaceSlug]);

  useEffect(() => {
    if (!activeId || (execution?.status !== 'running' && execution?.status !== 'waiting_for_input')) return;
    const source = new EventSource(api.agentExecutionEventsUrl(CHAT_BOT_AGENT_ID, activeId), { withCredentials: true });
    source.onopen = () => setMainConnectionState('connected');
    source.onerror = () => setMainConnectionState('reconnecting');
    source.onmessage = (message) => {
      try {
        const event = parseAgentExecutionEvent(message.data);
        const data = event.data;
        if (data.kind === 'snapshot') {
          setExecution(data.execution);
          void applyCompletedResults(data.execution);
        } else if (data.kind === 'message_delta') {
          setExecution((current) => {
            if (!current) return current;
            const existing = current.messages.find((item) => item.id === data.messageId);
            const messages = existing
              ? current.messages.map((item) => item.id === data.messageId ? { ...item, content: item.content + data.delta } : item)
              : [...current.messages, { id: data.messageId, role: 'assistant' as const, content: data.delta, createdAt: event.createdAt }];
            return { ...current, messages };
          });
        }
      } catch {
        setMainConnectionState('reconnecting');
      }
    };
    return () => source.close();
  }, [activeId, applyCompletedResults, execution?.status]);

  const workflowRunId = workflowRun?.run.id;
  useEffect(() => {
    if (!workflowRunId || !workflowRunning) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await api.run(workspaceSlug, workflowRunId);
        if (!cancelled) setWorkflowRun((current) => current && current.run.id === next.id ? { ...current, run: next } : current);
      } catch {
        // The run remains visible and can be refreshed from the Runs surface.
      }
    };
    const timer = window.setInterval(() => void poll(), 1_000);
    void poll();
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [workflowRunId, workflowRunning, workspaceSlug]);

  useEffect(() => {
    if (locationSearch.assistant === 'open') setOpen(true);
  }, [locationSearch.assistant]);

  useEffect(() => {
    if (!open || isHome) return;
    const frame = window.requestAnimationFrame(() => document.getElementById('assistant-message')?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isHome, open]);

  // The composer handles its own Escape. This covers the rest of the panel — a focused
  // tab, an expanded Skill row — without making the panel container itself interactive.
  useEffect(() => {
    if (!open) return;
    function handlePanelKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Node) || !chatSurfaceRef.current?.contains(target)) return;
      if (target instanceof HTMLTextAreaElement) return;
      if (escapeRef.current()) event.preventDefault();
    }
    document.addEventListener('keydown', handlePanelKeyDown);
    return () => document.removeEventListener('keydown', handlePanelKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleOutsidePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const element = target instanceof Element ? target : null;
      if (chatSurfaceRef.current?.contains(target) || element?.closest('[data-radix-popper-content-wrapper]')) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', handleOutsidePointerDown);
    return () => document.removeEventListener('pointerdown', handleOutsidePointerDown);
  }, [open]);

  // A queued message belongs to the turn after the current one. Sending it while the
  // execution is failed, cancelled by the reader, or waiting on a clarification would
  // either waste a call on a missing result or answer the wrong question, so the queue
  // holds its entries instead of draining them.
  useEffect(() => {
    if (queued.length === 0 || queuePaused || busy || !activeId) return;
    if (visibleExecution?.status !== 'completed') return;
    const [next, ...rest] = queued;
    let cancelled = false;
    const send = async () => {
      setBusy(true);
      try {
        const result = await api.continueAgentExecution(workspaceSlug, CHAT_BOT_AGENT_ID, activeId, next.text);
        if (cancelled) return;
        setQueued(rest);
        setExecution(result);
        void applyCompletedResults(result);
      } catch (sendError) {
        if (cancelled) return;
        setQueuePaused(true);
        setError(apiErrorMessage(sendError, t('assistant:execution.requestFailed')));
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void send();
    return () => { cancelled = true; };
  }, [activeId, applyCompletedResults, busy, queued, queuePaused, t, visibleExecution?.status, workspaceSlug]);

  useEffect(() => {
    if (visibleExecution?.status === 'failed' || visibleExecution?.status === 'cancelled' || visibleExecution?.status === 'waiting_for_input') setQueuePaused(true);
  }, [visibleExecution?.status]);

  function enqueue(text: string) {
    setQueued((current) => [...current, { id: `queued_${Date.now()}_${current.length}`, text }]);
    setDraft('');
    setSlashDismissed(false);
    setMentionDismissed(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmedMessage = draft.trim();
    if (busy || (!trimmedMessage && !selectedWorkflow)) return;
    const command = trimmedMessage.toLowerCase();
    if (command === '/log' || command === '/new' || command === '/resume') {
      runCommand(command);
      return;
    }
    if (selectedWorkflow) {
      if (!selectedWorkflow.latestVersionId) return;
      setBusy(true);
      setError('');
      try {
        const created = await api.createRun(selectedWorkflow.latestVersionId, { input: trimmedMessage });
        const run = await api.run(workspaceSlug, created.runId);
        setWorkflowRun({ workflow: selectedWorkflow, run, input: trimmedMessage });
        setSelectedWorkflow(null);
        setDraft('');
        setMentionDismissed(false);
        setOpen(true);
      } catch (runError) {
        setError(apiErrorMessage(runError, t('assistant:workflowRun.requestFailed')));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (waitingForInput && visibleExecution?.pendingQuestion) {
      setBusy(true);
      setError('');
      try {
        const next = await api.answerAgentQuestion(workspaceSlug, CHAT_BOT_AGENT_ID, visibleExecution.id, { questionId: visibleExecution.pendingQuestion.id, answer: trimmedMessage });
        setExecution(next);
        setDraft('');
        setQueuePaused(false);
        setOpen(true);
      } catch (answerError) {
        setError(apiErrorMessage(answerError, t('assistant:execution.answerFailed')));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!isConfigured) return;
    if (running) {
      enqueue(trimmedMessage);
      setOpen(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next = activeId
        ? await api.continueAgentExecution(workspaceSlug, CHAT_BOT_AGENT_ID, activeId, trimmedMessage)
        : await api.createAgentExecution(workspaceSlug, CHAT_BOT_AGENT_ID, trimmedMessage);
      setActiveId(next.id);
      setExecution(next);
      setQueuePaused(false);
      void applyCompletedResults(next);
      setDraft('');
      setOpen(true);
    } catch (requestError) {
      setError(apiErrorMessage(requestError, t('assistant:execution.requestFailed')));
    } finally {
      setBusy(false);
    }
  }

  async function cancelExecution() {
    if (workflowRunning && workflowRun && !busy) {
      setBusy(true);
      setError('');
      try {
        const run = await api.cancelRun(workspaceSlug, workflowRun.run.id);
        setWorkflowRun((current) => current ? { ...current, run } : current);
      } catch (cancelError) {
        setError(apiErrorMessage(cancelError, t('assistant:workflowRun.cancelFailed')));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!visibleExecution || visibleExecution.status !== 'running' || busy) return;
    setBusy(true);
    setError('');
    setQueuePaused(true);
    try {
      setExecution(await api.cancelAgentExecution(workspaceSlug, CHAT_BOT_AGENT_ID, visibleExecution.id));
    } catch (cancelError) {
      setError(apiErrorMessage(cancelError, t('assistant:execution.cancelFailed')));
    } finally {
      setBusy(false);
    }
  }

  async function retryExecution() {
    if (!visibleExecution || visibleExecution.status !== 'failed' || busy) return;
    setBusy(true);
    setError('');
    try {
      setExecution(await api.retryAgentExecution(workspaceSlug, CHAT_BOT_AGENT_ID, visibleExecution.id));
      setMainConnectionState('connected');
      setQueuePaused(false);
      setOpen(true);
    } catch (retryError) {
      setError(apiErrorMessage(retryError, t('assistant:execution.requestFailed')));
    } finally {
      setBusy(false);
    }
  }

  function selectMention(workflow: WorkflowView) {
    if (!mentionMatch) return;
    const atIndex = draft.lastIndexOf('@');
    setDraft(atIndex >= 0 ? draft.slice(0, atIndex) : draft);
    setSelectedWorkflow(workflow);
    setMentionDismissed(true);
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
      if (!execution) {
        setError(t('assistant:log.noActive'));
        return;
      }
      setError('');
      downloadExecutionLog(execution, {
        title: t('assistant:log.title'),
        generated: t('assistant:log.generated'),
        executionId: t('assistant:log.executionId'),
        phase: t('assistant:log.phase'),
        errorCode: t('assistant:log.errorCode'),
        status: t('assistant:log.status'),
        incomplete: t('assistant:log.incomplete'),
        reason: t('assistant:log.reason'),
        cancelledReason: t('assistant:log.cancelledReason'),
        transcript: t('assistant:log.transcript'),
        noMessages: t('assistant:log.noMessages'),
        user: t('assistant:log.user'),
        assistant: t('assistant:log.assistant'),
        activity: t('assistant:log.activity'),
        noActivity: t('assistant:log.noActivity'),
        skill: t('assistant:log.skill'),
        script: t('assistant:log.script'),
        toolCallId: t('assistant:log.toolCallId'),
        commandExecutionId: t('assistant:log.commandExecutionId'),
        exitCode: t('assistant:log.exitCode'),
        statuses: {
          running: t('assistant:log.statuses.running'),
          waiting_for_input: t('assistant:log.statuses.waiting_for_input'),
          completed: t('assistant:log.statuses.completed'),
          cancelled: t('assistant:log.statuses.cancelled'),
          failed: t('assistant:log.statuses.failed'),
        },
      }, locale, executionError);
      return;
    }
    if (command === '/new') {
      archiveCurrent();
      setActiveId(null);
      setExecution(null);
      setQueued([]);
      setQueuePaused(false);
      setError('');
      return;
    }
    setSwitcherOpen(true);
  }

  function resume(item: ArchivedExecution) {
    if (execution && execution.id !== item.id) archiveCurrent();
    setActiveId(item.id);
    setArchived((current) => current.filter((entry) => entry.id !== item.id));
    setSwitcherOpen(false);
    setQueued([]);
    setQueuePaused(false);
    setError('');
    window.requestAnimationFrame(() => document.getElementById('assistant-message')?.focus());
  }

  // Escape dismisses exactly one layer per press, innermost first, so recovering from a
  // mistyped slash never also discards a chosen Workflow or collapses the conversation.
  function handleEscape(): boolean {
    if (commandMenuOpen || mentionMenuOpen) {
      setSlashDismissed(true);
      setMentionDismissed(true);
      return true;
    }
    if (selectedWorkflow) {
      setSelectedWorkflow(null);
      return true;
    }
    if (panelView === 'configuration' && isConfigured) {
      setPanelView('chat');
      return true;
    }
    if (open) {
      setOpen(false);
      return true;
    }
    return false;
  }

  escapeRef.current = handleEscape;

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape') {
      if (handleEscape()) event.preventDefault();
      return;
    }
    if (selectedWorkflow && !draft && event.key === 'Backspace') {
      setSelectedWorkflow(null);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (mentionMenuOpen) {
        const workflow = mentionMatches.find((item) => `mention:${item.id}` === activeValue) ?? mentionMatches[0];
        if (workflow) selectMention(workflow);
        return;
      }
      if (commandMenuOpen) {
        const command = commandMatches.find((item) => item.value === activeValue) ?? commandMatches[0];
        if (command) runCommand(command.value);
        return;
      }
      event.currentTarget.form?.requestSubmit();
      return;
    }
    if (!menuNavigationKey(event.key) || !(commandMenuOpen || mentionMenuOpen)) return;
    const values = mentionMenuOpen ? mentionMatches.map((item) => `mention:${item.id}`) : commandMatches.map((item) => item.value);
    if (values.length === 0) return;
    event.preventDefault();
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    const currentIndex = Math.max(0, values.indexOf(activeValue));
    setActiveValue(values[(currentIndex + offset + values.length) % values.length]);
  }

  function handleFloatingPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    floatingDragRef.current = { startX: event.clientX, startY: event.clientY, ...floatingPosition, moved: false };
    suppressFloatingClickRef.current = false;
  }

  function handleFloatingPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = floatingDragRef.current;
    const container = floatingContainerRef.current;
    if (!drag || !container) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
    drag.moved = true;
    const bounds = container.getBoundingClientRect();
    const maxRight = Math.max(12, bounds.width - 56 - 12);
    const maxBottom = Math.max(12, bounds.height - 56 - 12);
    setFloatingPosition({
      right: Math.max(12, Math.min(maxRight, drag.right - deltaX)),
      bottom: Math.max(12, Math.min(maxBottom, drag.bottom - deltaY)),
    });
  }

  function handleFloatingPointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = floatingDragRef.current;
    if (!drag) return;
    suppressFloatingClickRef.current = drag.moved;
    floatingDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function openFloatingChat() {
    if (suppressFloatingClickRef.current) {
      suppressFloatingClickRef.current = false;
      return;
    }
    setOpen(true);
  }

  function handlePanelTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextView = event.key === 'Home' ? 'chat' : event.key === 'End' ? 'configuration' : panelView === 'chat' ? 'configuration' : 'chat';
    setPanelView(nextView);
    window.requestAnimationFrame(() => document.getElementById(`assistant-${nextView}-tab`)?.focus());
  }

  const turns = visibleExecution ? groupTurns(visibleExecution) : [];
  const lastTurn = turns[turns.length - 1];
  const showWorkingInLastTurn = running && lastTurn?.kind === 'assistant';

  // The header badge reports server execution state only. A submission the server has
  // not accepted yet is reported by the Send control, not as a running execution.
  const status = workflowRun?.run.status === 'queued' ? t('assistant:status.queued')
    : workflowRun?.run.status === 'running' ? t('assistant:status.running')
    : workflowRun?.run.status === 'paused' ? t('assistant:status.paused')
    : workflowRun?.run.status === 'waiting_for_input' ? t('assistant:workflowRun.waitingForConfirmation')
    : connectionState === 'reconnecting' ? t('assistant:status.reconnecting')
    : visibleExecution?.status === 'failed' ? t('assistant:status.failed')
      : visibleExecution?.status === 'cancelled' ? t('assistant:status.cancelled')
        : visibleExecution?.status === 'completed' ? t('assistant:status.completed')
          : visibleExecution?.status === 'waiting_for_input' ? t('assistant:status.waiting_for_input')
            : visibleExecution?.status === 'running' ? t('assistant:status.running') : '';
  const composerAvailable = Boolean(isConfigured || eligibleWorkflows.length > 0);
  const composerLoading = agentQuery.isLoading || workflowsQuery.isLoading || mcpServersQuery.isLoading;
  const stopTarget = (running && !selectedWorkflow) || workflowRunning;
  const submitDisabled = busy || (!draft.trim() && !selectedWorkflow && !stopTarget) || (!selectedWorkflow && !stopTarget && !isConfigured);

  return (
    <div ref={floatingContainerRef} className={cn('pointer-events-none absolute z-30', isHome || open ? 'inset-x-3 bottom-3 sm:inset-x-6 sm:bottom-6' : 'inset-0')}>
      {!isHome && !open ? (
        <div className="pointer-events-auto absolute" style={{ right: floatingPosition.right, bottom: floatingPosition.bottom }}>
          <button
            type="button"
            className={cn('flex size-12 touch-none items-center justify-center rounded-full border border-brand/30 bg-brand text-white shadow-lg hover:bg-brand-hover', focusRing)}
            aria-label={t('assistant:open')}
            onClick={openFloatingChat}
            onPointerDown={handleFloatingPointerDown}
            onPointerMove={handleFloatingPointerMove}
            onPointerUp={handleFloatingPointerUp}
            onPointerCancel={handleFloatingPointerUp}
          >
            <Bot className="size-5" aria-hidden="true" />
            {status ? <span className="sr-only">{status}</span> : null}
          </button>
        </div>
      ) : null}

      {(isHome || open) ? (
        <div
          ref={chatSurfaceRef}
          className="pointer-events-auto mx-auto flex w-full max-w-[1200px] flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-md"
        >
          <div
            id="assistant-panel-content"
            aria-hidden={!open}
            inert={!open}
            className={cn('overflow-hidden transition-[height,opacity,transform] duration-200 motion-reduce:transition-none', open ? 'h-[min(680px,calc(100vh-96px))] translate-y-0 opacity-100 max-md:h-[min(70vh,680px)]' : 'pointer-events-none h-0 translate-y-2 opacity-0')}
          >
            <section className="flex h-full min-h-0 flex-col" aria-labelledby="assistant-panel-title">
              <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 id="assistant-panel-title" className="text-base font-semibold">{t('assistant:title')}</h2>
                    {status ? <Badge variant={visibleExecution?.status === 'failed' ? 'danger' : 'neutral'}>{status}</Badge> : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button type="button" variant="ghost" size="icon-compact" aria-label={t('assistant:minimized.minimize')} onClick={() => setOpen(false)}>
                        <ChevronDown className="size-4" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('assistant:minimized.minimize')}</TooltipContent>
                  </Tooltip>
                </div>
              </header>

              <div className="agent-tabs" role="tablist" aria-label={t('assistant:panelTabs.label')}>
                <button id="assistant-chat-tab" type="button" role="tab" aria-selected={panelView === 'chat'} tabIndex={panelView === 'chat' ? 0 : -1} className={cn(panelView === 'chat' && 'active')} onKeyDown={handlePanelTabKeyDown} onClick={() => setPanelView('chat')}>{t('assistant:panelTabs.chat')}</button>
                <button id="assistant-configuration-tab" type="button" role="tab" aria-selected={panelView === 'configuration'} tabIndex={panelView === 'configuration' ? 0 : -1} className={cn(panelView === 'configuration' && 'active')} onKeyDown={handlePanelTabKeyDown} onClick={() => setPanelView('configuration')}>{t('assistant:panelTabs.configuration')}</button>
              </div>

              {panelView === 'configuration' ? (
                <Configuration
                  providers={providersQuery.data ?? []}
                  mcpServers={mcpServersQuery.data ?? []}
                  selection={configSelection}
                  onSelectionChange={(value) => { setConfigSelection(value); void saveConfiguration(value, selectedMcpServerIds); }}
                  selectedMcpServerIds={selectedMcpServerIds}
                  onMcpServersChange={(ids) => { setSelectedMcpServerIds(ids); void saveConfiguration(configSelection, ids); }}
                  saving={configSaving}
                />
              ) : (
                <Conversation className="px-4" scrollToEndLabel={t('assistant:transcript.scrollToEnd')}>
                  <ConversationContent>
                    {turns.length === 0 && !workflowRun && !loadingExecution ? <StarterPane onSelect={(prompt) => { setDraft(prompt); setOpen(true); }} /> : null}
                    {loadingExecution ? <TranscriptSkeleton /> : null}
                    {turns.map((turn, index) => turn.kind === 'user'
                      ? <UserMessage key={turn.item.id} message={turn.item} />
                      : <AssistantTurn key={turn.segments[0].item.id} segments={turn.segments} working={showWorkingInLastTurn && index === turns.length - 1} />)}
                    {running && !showWorkingInLastTurn ? <AssistantTurn segments={[]} working /> : null}
                    {waitingForInput && visibleExecution?.pendingQuestion ? <QuestionNote question={visibleExecution.pendingQuestion} /> : null}
                    {visibleExecution?.status === 'cancelled' ? <CancelledNote /> : null}
                    {workflowRun ? <WorkflowRunRow run={workflowRun.run} workflow={workflowRun.workflow} input={workflowRun.input} /> : null}
                    {executionError ? <FailureNote execution={visibleExecution} message={executionError} onRetry={() => void retryExecution()} retryDisabled={busy} locale={locale} /> : null}
                    <QueueRows queued={queued} paused={queuePaused} onRemove={(id) => setQueued((current) => current.filter((item) => item.id !== id))} />
                    {error ? <p className="mt-4 border-l-2 border-danger pl-3 text-[13px] text-danger" role="alert">{error}</p> : null}
                  </ConversationContent>
                </Conversation>
              )}
            </section>
          </div>

          {!open && status ? (
            <button type="button" className={cn('flex min-h-8 items-center gap-2 border-b border-border px-3 text-left text-[13px] text-muted-foreground hover:bg-surface-subtle hover:text-foreground', surfaceInteraction, focusRingInset)} onClick={() => setOpen(true)}>
              <MessageSquareText className="size-4 shrink-0 text-brand" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{status}</span>
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
          ) : null}

          {composerLoading ? (
            <div className="flex min-h-12 items-center gap-2 px-3 text-[13px] text-muted-foreground" role="status">
              <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />{t('assistant:composer.loading')}
            </div>
          ) : composerAvailable ? (
            <Composer
              draft={draft}
              onDraftChange={(value) => { setDraft(value); setSlashDismissed(false); setMentionDismissed(false); setActiveValue(''); }}
              onSubmit={submit}
              onKeyDown={handleComposerKeyDown}
              onFocus={() => setOpen(true)}
              selectedWorkflow={selectedWorkflow}
              onRemoveWorkflow={() => setSelectedWorkflow(null)}
              commandMatches={commandMatches}
              commandMenuOpen={commandMenuOpen}
              onRunCommand={runCommand}
              mentionMatches={mentionMatches}
              mentionMenuOpen={mentionMenuOpen}
              onSelectMention={selectMention}
              activeValue={activeValue}
              onActiveValueChange={setActiveValue}
              onDismissMenus={() => { setSlashDismissed(true); setMentionDismissed(true); }}
              running={stopTarget}
              busy={busy}
              submitDisabled={submitDisabled}
              waitingForInput={Boolean(waitingForInput)}
              onStop={() => void cancelExecution()}
            />
          ) : (
            <button type="button" className={cn('flex min-h-12 w-full items-center gap-2 px-3 text-left text-[13px] font-medium hover:bg-surface-subtle', surfaceInteraction, focusRingInset)} onClick={() => { setPanelView('configuration'); setOpen(true); }}>
              <ShieldAlert className="size-4 shrink-0 text-brand" aria-hidden="true" />
              <span className="min-w-0 flex-1">{t('assistant:composer.configure')}</span>
              <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
            </button>
          )}
        </div>
      ) : null}

      <SessionSwitcher
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        archived={archived}
        onResume={resume}
        onRemove={(id) => setArchived((current) => current.filter((item) => item.id !== id))}
      />
    </div>
  );
}

function menuNavigationKey(key: string) {
  return key === 'ArrowDown' || key === 'ArrowUp';
}

export { ChatBot, CHAT_BOT_AGENT_ID };
