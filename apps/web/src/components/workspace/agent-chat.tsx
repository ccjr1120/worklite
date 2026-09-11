import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { ArrowLeft, ArrowUp, Ban, Bot, CheckCircle2, ChevronDown, ChevronRight, CircleX, Download, FileCode2, History, LoaderCircle, MessageSquareText, Plus, RefreshCw, ShieldAlert, Square, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentExecutionView, AgentSubSessionView, AgentToolCallView, AgentView, McpServerView } from '@worklite/contracts';
import { ApiError, api, parseAgentExecutionEvent } from '@/api/client';
import { agentSubSessionsQueryKey, useAgentQuery, useAgentsQuery, useAgentSubSessionsQuery, useMcpServersQuery, useModelProvidersQuery } from '@/api/queries';
import { Conversation, ConversationContent } from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { PromptInput, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input';
import { useLocale } from '@/components/locale-provider';
import { useTheme } from '@/components/theme-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { focusRing, focusRingInset, surfaceInteraction } from '@/components/ui/interaction';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDateTime } from '@/i18n/format';
import type { AppLocale } from '@/i18n/locale';
import { queryClient } from '@/lib/query-client';
import { cn } from '@/lib/utils';

const SYSTEM_HELPER_CHAT_ID = 'agt_system_helper_chat';
const HISTORY_LIMIT = 20;
const INCOMPLETE_SKILL_REQUEST = 'The model returned an incomplete Skill request. Its JSON ended before the request was complete.';
const INVALID_SKILL_REQUEST = 'The model returned an invalid Skill request. Its arguments could not be parsed or did not match the required structure.';
const GENERIC_AGENT_ERROR = 'The Agent could not complete this turn. Check its provider configuration and try again.';
const AGENT_TURN_ERROR = 'The Agent could not complete this turn.';
const SKILL_EXECUTION_ERROR = 'The Agent Skill script could not be completed.';
const RESTARTED_AGENT_ERROR = 'The API restarted before this Agent turn completed.';

type ArchivedExecution = { id: string; label: string; archivedAt: string };
type StoredExecutionState = { activeId: string | null; activeSubSessionId: string | null; archived: ArchivedExecution[] };
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
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { activeId: null, activeSubSessionId: null, archived: [] };
    const record = value as Record<string, unknown>;
    const activeId = typeof record.activeId === 'string' ? record.activeId : null;
    const activeSubSessionId = typeof record.activeSubSessionId === 'string' ? record.activeSubSessionId : null;
    const archived = Array.isArray(record.archived)
      ? record.archived.flatMap((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
          const entry = item as Record<string, unknown>;
          return typeof entry.id === 'string' && typeof entry.label === 'string' && typeof entry.archivedAt === 'string'
            ? [{ id: entry.id, label: entry.label, archivedAt: entry.archivedAt }]
            : [];
        }).slice(0, HISTORY_LIMIT)
      : [];
    return { activeId, activeSubSessionId, archived };
  } catch {
    return { activeId: null, activeSubSessionId: null, archived: [] };
  }
}

function AgentChat({ workspaceSlug }: { workspaceSlug: string }) {
  const { t } = useTranslation(['assistant', 'common']);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const locationSearch = useRouterState({ select: (state) => state.location.search as Record<string, unknown> });
  const navigate = useNavigate();
  const agentQuery = useAgentQuery(workspaceSlug, SYSTEM_HELPER_CHAT_ID);
  const providersQuery = useModelProvidersQuery(workspaceSlug);
  const mcpServersQuery = useMcpServersQuery(workspaceSlug);
  const agentsQuery = useAgentsQuery(workspaceSlug);
  const subSessionsQuery = useAgentSubSessionsQuery(workspaceSlug);
  const { applyAppearancePreference } = useTheme();
  const { applyLocalePreference, locale } = useLocale();
  const initialState = useMemo(() => readStoredState(workspaceSlug), [workspaceSlug]);
  const [targetIds, setTargetIds] = useState({ 'system-helper': initialState.activeId });
  const [archived, setArchived] = useState<ArchivedExecution[]>(initialState.archived);
  const [execution, setExecution] = useState<AgentExecutionView | null>(null);
  const [activeSubSessionId, setActiveSubSessionId] = useState<string | null>(initialState.activeSubSessionId);
  const [subExecution, setSubExecution] = useState<AgentExecutionView | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentView | null>(null);
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [panelView, setPanelView] = useState<'chat' | 'configuration'>(initialState.activeId ? 'chat' : 'configuration');
  const [configSelection, setConfigSelection] = useState('');
  const [selectedMcpServerIds, setSelectedMcpServerIds] = useState<string[]>([]);
  const [configSaving, setConfigSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingExecution, setLoadingExecution] = useState(Boolean(initialState.activeId));
  const [loadingSubExecution, setLoadingSubExecution] = useState(false);
  const [error, setError] = useState('');
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [mainConnectionState, setMainConnectionState] = useState<'connected' | 'reconnecting'>('connected');
  const [subConnectionState, setSubConnectionState] = useState<'connected' | 'reconnecting'>('connected');
  const [floatingPosition, setFloatingPosition] = useState({ right: 24, bottom: 24 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatSurfaceRef = useRef<HTMLDivElement>(null);
  const floatingContainerRef = useRef<HTMLDivElement>(null);
  const floatingDragRef = useRef<{ startX: number; startY: number; right: number; bottom: number; moved: boolean } | null>(null);
  const suppressFloatingClickRef = useRef(false);
  const shouldFollowEndRef = useRef(true);
  const currentPathRef = useRef(pathname);
  const appliedResultIdsRef = useRef(new Set<string>());
  const mainRequestGenerationRef = useRef(0);
  const subRequestGenerationRef = useRef(0);
  const isConfigured = Boolean(agentQuery.data?.providerId && agentQuery.data?.model);
  useEffect(() => {
    if (!agentQuery.data) return;
    setConfigSelection(agentQuery.data.providerId && agentQuery.data.model ? `${agentQuery.data.providerId}::${agentQuery.data.model}` : '');
    setSelectedMcpServerIds(agentQuery.data.mcpServers.map((server) => server.id));
    if (agentQuery.data.providerId && agentQuery.data.model) setPanelView('chat');
  }, [agentQuery.data]);
  const saveConfiguration = async (selection = configSelection) => {
    if (!selection || configSaving) return;
    const separator = selection.indexOf('::');
    if (separator < 0) return;
    setConfigSaving(true);
    try {
      await api.updateAgent(workspaceSlug, SYSTEM_HELPER_CHAT_ID, { providerId: selection.slice(0, separator), model: selection.slice(separator + 2), mcpServerIds: selectedMcpServerIds });
      await queryClient.invalidateQueries({ queryKey: ['agent', SYSTEM_HELPER_CHAT_ID] });
      setPanelView('chat');
    } finally { setConfigSaving(false); }
  };
  const activeId = targetIds['system-helper'] ?? null;
  const executionAgentId = SYSTEM_HELPER_CHAT_ID;
  const setActiveId = (id: string | null) => setTargetIds((current) => ({ ...current, 'system-helper': id }));
  const subSessions = subSessionsQuery.data ?? [];
  const activeSubSession = subSessions.find((session) => session.id === activeSubSessionId) ?? null;
  const visibleExecution = activeSubSession ? subExecution : execution;
  const connectionState = activeSubSession ? subConnectionState : mainConnectionState;
  const running = visibleExecution?.status === 'running';
  const isHome = pathname === '/home';
  const waitingForInput = visibleExecution?.status === 'waiting_for_input';
  const mainRunning = execution?.status === 'running';
  const eligibleAgents = useMemo(() => (agentsQuery.data ?? []).filter((agent) => agent.kind === 'custom' && agent.providerId && agent.model), [agentsQuery.data]);
  const mentionMatch = !activeSubSession && !selectedAgent ? /(?:^|\s)@([^\s@]*)$/.exec(draft) : null;
  const mentionQuery = mentionMatch?.[1]?.toLocaleLowerCase() ?? '';
  const mentionMatches = mentionMatch && !mentionDismissed
    ? eligibleAgents.filter((agent) => `${agent.name} ${agent.responsibility}`.toLocaleLowerCase().includes(mentionQuery))
    : [];
  const mentionMenuOpen = Boolean(mentionMatch && !mentionDismissed);
  const slashQuery = draft.trimStart().toLowerCase();
  const commandMatches = !activeSubSession && !selectedAgent && !mentionMenuOpen && !mainRunning && slashQuery.startsWith('/') && !slashDismissed ? SLASH_COMMANDS.filter((command) => command.value.startsWith(slashQuery)) : [];
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
      applyLocalePreference(saved.locale);
      return;
    }
    if (result.type === 'navigation') void navigate({ to: result.route as never });
  }, [applyAppearancePreference, applyLocalePreference, navigate]);

  const applyCompletedResults = useCallback(async (next: AgentExecutionView) => {
    for (const call of next.toolCalls) {
      if (call.status !== 'completed' || appliedResultIdsRef.current.has(call.id)) continue;
      appliedResultIdsRef.current.add(call.id);
      await applyCompletedResult(call);
    }
  }, [applyCompletedResult]);

  useEffect(() => {
    window.localStorage.setItem(storageKey(workspaceSlug), JSON.stringify({ activeId, activeSubSessionId, archived } satisfies StoredExecutionState));
  }, [activeId, activeSubSessionId, archived, workspaceSlug]);

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
        const next = await api.agentExecution(workspaceSlug, executionAgentId, activeId);
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
  }, [activeId, executionAgentId, t, workspaceSlug]);

  useEffect(() => {
    if (!activeId || (execution?.status !== 'running' && execution?.status !== 'waiting_for_input')) return;
    const source = new EventSource(api.agentExecutionEventsUrl(executionAgentId, activeId), { withCredentials: true });
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
  }, [activeId, applyCompletedResults, execution?.status, executionAgentId]);

  useEffect(() => {
    let cancelled = false;
    const generation = ++subRequestGenerationRef.current;
    let retryTimer: number | undefined;
    if (!activeSubSessionId) {
      setSubExecution(null);
      setLoadingSubExecution(false);
      setSubConnectionState('connected');
      return;
    }
    if (!activeSubSession) {
      if (!subSessionsQuery.isLoading) setActiveSubSessionId(null);
      return;
    }
    setLoadingSubExecution(true);
    let delay = 1_500;
    const load = async () => {
      if (cancelled || generation !== subRequestGenerationRef.current) return;
      try {
        const next = await api.agentExecution(workspaceSlug, activeSubSession.agentId, activeSubSession.executionId);
        if (cancelled || generation !== subRequestGenerationRef.current) return;
        setSubConnectionState('connected');
        setError('');
        setSubExecution(next);
      } catch (loadError) {
        if (cancelled || generation !== subRequestGenerationRef.current) return;
        if (loadError instanceof ApiError && loadError.status < 500) {
          setSubConnectionState('connected');
          setError(apiErrorMessage(loadError, t('assistant:execution.loadFailed')));
          return;
        }
        setSubConnectionState('reconnecting');
        retryTimer = window.setTimeout(load, delay);
        delay = Math.min(delay * 2, 12_000);
      } finally {
        if (!cancelled) setLoadingSubExecution(false);
      }
    };
    void load();
    return () => { cancelled = true; if (retryTimer !== undefined) window.clearTimeout(retryTimer); };
  }, [activeSubSession, activeSubSessionId, subSessionsQuery.isLoading, t, workspaceSlug]);

  useEffect(() => {
    if (!activeSubSession || (subExecution?.status !== 'running' && subExecution?.status !== 'waiting_for_input')) return;
    const source = new EventSource(api.agentExecutionEventsUrl(activeSubSession.agentId, activeSubSession.executionId), { withCredentials: true });
    source.onopen = () => setSubConnectionState('connected');
    source.onerror = () => setSubConnectionState('reconnecting');
    source.onmessage = (message) => {
      try {
        const event = parseAgentExecutionEvent(message.data);
        const data = event.data;
        if (data.kind === 'snapshot') {
          setSubExecution(data.execution);
          if (data.execution.status !== 'running') void queryClient.invalidateQueries({ queryKey: agentSubSessionsQueryKey() });
        } else if (data.kind === 'message_delta') {
          setSubExecution((current) => {
            if (!current) return current;
            const existing = current.messages.find((item) => item.id === data.messageId);
            const messages = existing
              ? current.messages.map((item) => item.id === data.messageId ? { ...item, content: item.content + data.delta } : item)
              : [...current.messages, { id: data.messageId, role: 'assistant' as const, content: data.delta, createdAt: event.createdAt }];
            return { ...current, messages };
          });
        }
      } catch {
        setSubConnectionState('reconnecting');
      }
    };
    return () => source.close();
  }, [activeSubSession, subExecution?.status]);

  useEffect(() => {
    if (!activeSubSession || !activeSubSession.unread || subExecution?.status === 'running') return;
    void api.updateAgentSubSession(workspaceSlug, activeSubSession.id, false).then((updated) => {
      queryClient.setQueryData<AgentSubSessionView[]>(agentSubSessionsQueryKey(), (current = []) => current.map((item) => item.id === updated.id ? updated : item));
    }).catch(() => undefined);
  }, [activeSubSession, subExecution?.status, workspaceSlug]);

  useEffect(() => {
    if (locationSearch.assistant === 'open') setOpen(true);
  }, [locationSearch.assistant]);

  useEffect(() => {
    if (!open || isHome) return;
    const frame = window.requestAnimationFrame(() => document.getElementById('assistant-message')?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isHome, open]);

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

  useEffect(() => {
    if (!open) return;
    if (!shouldFollowEndRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [historyOpen, open, visibleExecution]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmedMessage = draft.trim();
    if (!trimmedMessage || busy) return;
    const command = trimmedMessage.toLowerCase();
    if (!activeSubSession && !selectedAgent && (command === '/log' || command === '/new' || command === '/resume')) {
      runCommand(command);
      return;
    }
    if (selectedAgent) {
      setBusy(true);
      setError('');
      try {
        const session = await api.createAgentSubSession(workspaceSlug, { agentId: selectedAgent.id, message: draft });
        queryClient.setQueryData<AgentSubSessionView[]>(agentSubSessionsQueryKey(), (current = []) => [session, ...current.filter((item) => item.id !== session.id)]);
        setSelectedAgent(null);
        setDraft('');
        setHistoryOpen(false);
        setActiveSubSessionId(session.id);
        setOpen(true);
      } catch (createError) {
        setError(apiErrorMessage(createError, t('assistant:subAgents.createFailed')));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (waitingForInput && visibleExecution?.pendingQuestion) {
      setBusy(true);
      setError('');
      try {
        const next = await api.answerAgentQuestion(workspaceSlug, activeSubSession?.agentId ?? SYSTEM_HELPER_CHAT_ID, visibleExecution.id, { questionId: visibleExecution.pendingQuestion.id, answer: trimmedMessage });
        if (activeSubSession) setSubExecution(next);
        else setExecution(next);
        setDraft('');
        setOpen(true);
      } catch (answerError) {
        setError(apiErrorMessage(answerError, t('assistant:execution.answerFailed')));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (running || (!activeSubSession && !isConfigured)) return;
    setBusy(true);
    setError('');
    try {
      if (activeSubSession) {
        const next = await api.continueAgentExecution(workspaceSlug, activeSubSession.agentId, activeSubSession.executionId, trimmedMessage);
        setSubExecution(next);
        void queryClient.invalidateQueries({ queryKey: agentSubSessionsQueryKey() });
      } else {
        const next = activeId
          ? await api.continueAgentExecution(workspaceSlug, executionAgentId, activeId, trimmedMessage)
          : await api.createAgentExecution(workspaceSlug, executionAgentId, trimmedMessage);
        setActiveId(next.id);
        setExecution(next);
        void applyCompletedResults(next);
      }
      setDraft('');
      setHistoryOpen(false);
      setOpen(true);
    } catch (requestError) {
      setError(apiErrorMessage(requestError, t(activeSubSession ? 'assistant:subAgents.requestFailed' : 'assistant:execution.requestFailed')));
    } finally {
      setBusy(false);
    }
  }

  async function cancelExecution() {
    if (!visibleExecution || visibleExecution.status !== 'running' || busy) return;
    setBusy(true);
    setError('');
    try {
      if (activeSubSession) {
        setSubExecution(await api.cancelAgentExecution(workspaceSlug, activeSubSession.agentId, activeSubSession.executionId));
        void queryClient.invalidateQueries({ queryKey: agentSubSessionsQueryKey() });
      } else {
        setExecution(await api.cancelAgentExecution(workspaceSlug, executionAgentId, visibleExecution.id));
      }
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
      if (activeSubSession) {
        setSubExecution(await api.retryAgentExecution(workspaceSlug, activeSubSession.agentId, activeSubSession.executionId));
        void queryClient.invalidateQueries({ queryKey: agentSubSessionsQueryKey() });
      } else {
        setExecution(await api.retryAgentExecution(workspaceSlug, executionAgentId, visibleExecution.id));
      }
      if (activeSubSession) setSubConnectionState('connected');
      else setMainConnectionState('connected');
      setOpen(true);
    } catch (retryError) {
      setError(apiErrorMessage(retryError, t(activeSubSession ? 'assistant:subAgents.requestFailed' : 'assistant:execution.requestFailed')));
    } finally {
      setBusy(false);
    }
  }

  function selectMention(agent: AgentView) {
    if (!mentionMatch) return;
    const atIndex = draft.lastIndexOf('@');
    setDraft(atIndex >= 0 ? draft.slice(0, atIndex) : draft);
    setSelectedAgent(agent);
    setMentionDismissed(true);
    setActiveMentionIndex(0);
  }

  function openSubSession(session: AgentSubSessionView) {
    setActiveSubSessionId(session.id);
    setSubConnectionState('connected');
    setHistoryOpen(false);
    setSelectedAgent(null);
    setError('');
    setOpen(true);
    if (!session.unread) return;
    void api.updateAgentSubSession(workspaceSlug, session.id, false).then((updated) => {
      queryClient.setQueryData<AgentSubSessionView[]>(agentSubSessionsQueryKey(), (current = []) => current.map((item) => item.id === updated.id ? updated : item));
    }).catch(() => undefined);
  }

  async function closeSubSession(session: AgentSubSessionView) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteAgentSubSession(workspaceSlug, session.id);
      queryClient.setQueryData<AgentSubSessionView[]>(agentSubSessionsQueryKey(), (current = []) => current.filter((item) => item.id !== session.id));
      if (activeSubSessionId === session.id) {
        setActiveSubSessionId(null);
        setSubExecution(null);
        setMainConnectionState('connected');
      }
    } catch (closeError) {
      setError(apiErrorMessage(closeError, t('assistant:subAgents.closeFailed')));
    } finally {
      setBusy(false);
    }
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

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionMenuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (mentionMatches.length > 0) {
          const offset = event.key === 'ArrowDown' ? 1 : -1;
          setActiveMentionIndex((current) => (current + offset + mentionMatches.length) % mentionMatches.length);
        }
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const agent = mentionMatches[activeMentionIndex] ?? mentionMatches[0];
        if (agent) selectMention(agent);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setMentionDismissed(true);
      }
      return;
    }
    if (selectedAgent && !draft && event.key === 'Backspace') {
      setSelectedAgent(null);
      return;
    }
    if (running && !selectedAgent && event.key === 'Enter') {
      event.preventDefault();
      return;
    }
    if (commandMatches.length === 0) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }
      return;
    }
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

  const events = visibleExecution ? [
    ...visibleExecution.messages.map((item) => ({ kind: 'message' as const, occurredAt: item.createdAt, item })),
    ...visibleExecution.toolCalls.map((item) => ({ kind: 'tool' as const, occurredAt: item.createdAt, item })),
  ].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)) : [];

  const status = busy ? t('assistant:status.running')
    : connectionState === 'reconnecting' ? t('assistant:status.reconnecting')
    : visibleExecution?.status === 'failed' ? t('assistant:status.failed')
      : visibleExecution?.status === 'cancelled' ? t('assistant:status.cancelled')
        : visibleExecution?.status === 'completed' ? t('assistant:status.completed')
    : visibleExecution?.status === 'waiting_for_input' ? t('assistant:status.waiting_for_input')
      : visibleExecution?.status === 'running' ? t('assistant:status.running') : '';
  const composerAvailable = Boolean(activeSubSession || isConfigured || eligibleAgents.length > 0);
  const composerLoading = agentQuery.isLoading || agentsQuery.isLoading || subSessionsQuery.isLoading || mcpServersQuery.isLoading;

  return (
    <div ref={floatingContainerRef} className={cn('pointer-events-none absolute z-30', isHome || open ? 'inset-x-3 bottom-3 sm:inset-x-6 sm:bottom-6' : 'inset-0')}>
      {!isHome && !open ? <div className="pointer-events-auto absolute" style={{ right: floatingPosition.right, bottom: floatingPosition.bottom }}>
        <button type="button" className={cn('flex size-12 touch-none items-center justify-center rounded-full border border-brand/30 bg-brand text-white shadow-lg hover:bg-brand-hover', focusRing)} aria-label={t('assistant:open')} onClick={openFloatingChat} onPointerDown={handleFloatingPointerDown} onPointerMove={handleFloatingPointerMove} onPointerUp={handleFloatingPointerUp} onPointerCancel={handleFloatingPointerUp}><Bot className="size-5" aria-hidden="true" />{status ? <span className="sr-only">{status}</span> : null}</button>
      </div> : null}
      {(isHome || open) ? <div ref={chatSurfaceRef} className="pointer-events-auto mx-auto flex w-full max-w-[1200px] flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-md">
        <div id="assistant-panel-content" aria-hidden={!open} inert={!open} className={cn('overflow-hidden transition-[height,opacity,transform] duration-200 motion-reduce:transition-none', open ? 'h-[min(680px,calc(100vh-96px))] translate-y-0 opacity-100 max-md:h-[min(70vh,680px)]' : 'pointer-events-none h-0 translate-y-2 opacity-0')}>
          <section className="flex h-full min-h-0 flex-col" aria-labelledby="assistant-panel-title">
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="assistant-panel-title" className="text-base font-semibold">{activeSubSession?.agentName ?? t('assistant:title')}</h2>
                  {status ? <Badge variant={visibleExecution?.status === 'failed' ? 'danger' : 'neutral'}>{status}</Badge> : null}
                </div>
                <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{activeSubSession?.title ?? t('assistant:description')}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {activeSubSession ? <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-compact" aria-label={t('assistant:subAgents.return')} onClick={() => { setActiveSubSessionId(null); setSubExecution(null); setError(''); }}><ArrowLeft className="size-4" /></Button></TooltipTrigger><TooltipContent>{t('assistant:subAgents.return')}</TooltipContent></Tooltip> : null}
                {activeSubSession ? <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-compact" aria-label={t('assistant:subAgents.close')} disabled={busy} onClick={() => void closeSubSession(activeSubSession)}><X className="size-4" /></Button></TooltipTrigger><TooltipContent>{t('assistant:subAgents.close')}</TooltipContent></Tooltip> : null}
                <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-compact" aria-label={t('assistant:minimized.minimize')} onClick={() => setOpen(false)}><ChevronDown className="size-4" /></Button></TooltipTrigger><TooltipContent>{t('assistant:minimized.minimize')}</TooltipContent></Tooltip>
              </div>
            </header>

            <div className="agent-tabs" role="tablist" aria-label={t('assistant:panelTabs.label')}>
              <button type="button" role="tab" aria-selected={panelView === 'chat'} className={cn(panelView === 'chat' && 'active')} onClick={() => setPanelView('chat')}>{t('assistant:panelTabs.chat')}</button>
              <button type="button" role="tab" aria-selected={panelView === 'configuration'} className={cn(panelView === 'configuration' && 'active')} onClick={() => setPanelView('configuration')}>{t('assistant:panelTabs.configuration')}</button>
            </div>

            {panelView === 'configuration' ? (
              <form className="agent-config-form" onSubmit={(event) => event.preventDefault()}>
                <div className="agent-config-scroll">
                  <section className="agent-config-section">
                    <div className="agent-config-heading"><span className="font-mono text-[10px] uppercase tracking-[0.1em] text-info">Agent</span><h3>{t('assistant:configuration.title')}</h3><p>{t('assistant:configuration.description')}</p></div>
                    <div className="agent-config-fields"><label className="config-field" htmlFor="assistant-model-selection"><span>{t('assistant:configuration.model')}</span><Select value={configSelection} onValueChange={(value) => { setConfigSelection(value); const separator = value.indexOf('::'); if (separator >= 0) void saveConfiguration(value); }}>
                    <SelectTrigger id="assistant-model-selection"><SelectValue placeholder={t('assistant:configuration.placeholder')} /></SelectTrigger>
                    <SelectContent>{(providersQuery.data ?? []).flatMap((provider) => (provider.models ?? []).map((model) => <SelectItem key={`${provider.id}::${model}`} value={`${provider.id}::${model}`}>{provider.name} / {model}</SelectItem>))}</SelectContent>
                    </Select><small>{configSaving ? t('assistant:configuration.saving') : t('assistant:configuration.hint')}</small></label><fieldset className="config-field"><legend>{t('assistant:configuration.mcpServers')}</legend><div className="space-y-2">{(mcpServersQuery.data ?? []).map((server: McpServerView) => <label key={server.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selectedMcpServerIds.includes(server.id)} onChange={(event) => { const next = event.target.checked ? [...selectedMcpServerIds, server.id] : selectedMcpServerIds.filter((id) => id !== server.id); setSelectedMcpServerIds(next); void saveConfiguration(configSelection); }} />{server.name}</label>)}</div><small>{t('assistant:configuration.mcpServersHint')}</small></fieldset></div>
                  </section>
                </div>
                <div className="agent-config-actions"><span>{t('assistant:configuration.hint')}</span></div>
              </form>
            ) : historyOpen ? (
              <HistoryPane archived={archived} loading={loadingExecution} onResume={resume} onRemove={(id) => setArchived((current) => current.filter((item) => item.id !== id))} />
            ) : (
              <Conversation
                ref={scrollRef}
                className="px-4"
                onScroll={(event) => {
                  const element = event.currentTarget;
                  shouldFollowEndRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
                }}
              >
                <ConversationContent>
                  {events.length === 0 && !loadingExecution && !loadingSubExecution && !activeSubSession ? <StarterPane onSelect={(prompt) => { setDraft(prompt); setOpen(true); }} /> : null}
                  {(activeSubSession ? loadingSubExecution : loadingExecution) ? <p className="m-auto flex items-center gap-2 text-sm text-muted-foreground" role="status"><LoaderCircle className="size-4 motion-safe:animate-spin" />{t('assistant:execution.loading')}</p> : null}
                  {events.map((event) => event.kind === 'message' ? <MessageRow key={event.item.id} message={event.item} assistantName={activeSubSession?.agentName} /> : <ToolCallPanel key={event.item.id} call={event.item} />)}
          {running ? <WorkingRow /> : null}
                  {waitingForInput && visibleExecution?.pendingQuestion ? <QuestionRow question={visibleExecution.pendingQuestion} /> : null}
                  {visibleExecution?.status === 'cancelled' ? <CancelledRow /> : null}
                  {executionError ? <FailureRow execution={visibleExecution} message={executionError} onRetry={() => void retryExecution()} retryDisabled={busy} locale={locale} /> : null}
                  {error ? <p className="mt-4 border-l-2 border-danger pl-3 text-[13px] text-danger" role="alert">{error}</p> : null}
                </ConversationContent>
              </Conversation>
            )}
            {subSessions.length > 0 ? <SubAgentBand sessions={subSessions} activeId={activeSubSessionId} onSelect={openSubSession} /> : null}
          </section>
        </div>

        {!open && status ? <button type="button" className={cn('flex min-h-8 items-center gap-2 border-b border-border px-3 text-left text-[13px] text-muted-foreground hover:bg-surface-subtle hover:text-foreground', surfaceInteraction, focusRingInset)} onClick={() => setOpen(true)}><MessageSquareText className="size-4 shrink-0 text-brand" /><span className="min-w-0 flex-1 truncate">{status}</span><ChevronRight className="size-4" /></button> : null}

        {panelView === 'configuration' ? <div className="min-h-12 border-t border-border bg-surface" aria-hidden="true" /> : composerLoading ? (
          <div className="flex min-h-12 items-center gap-2 px-3 text-[13px] text-muted-foreground" role="status"><LoaderCircle className="size-4 motion-safe:animate-spin" />{t('assistant:composer.loading')}</div>
        ) : composerAvailable ? (
          <PromptInput onSubmit={submit}>
            <label htmlFor="assistant-message" className="sr-only">{t('assistant:composer.label')}</label>
            <Popover open={commandMatches.length > 0 || mentionMenuOpen} onOpenChange={(next) => { if (next) return; setSlashDismissed(true); setMentionDismissed(true); }}>
              <PopoverAnchor asChild><div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 rounded-md border border-border bg-surface px-2 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
                {selectedAgent ? <span className="inline-flex h-7 max-w-[min(12rem,45%)] shrink-0 items-center gap-1.5 rounded-md border border-brand/30 bg-brand-subtle px-2 text-[13px] font-medium text-foreground"><Bot className="size-3.5 shrink-0 text-brand" /><span className="truncate">{selectedAgent.name}</span><Tooltip><TooltipTrigger asChild><button type="button" className={cn('rounded-sm text-muted-foreground hover:text-foreground', focusRingInset)} aria-label={t('assistant:mentions.remove')} onClick={() => setSelectedAgent(null)}><X className="size-3.5" /></button></TooltipTrigger><TooltipContent>{t('assistant:mentions.remove')}</TooltipContent></Tooltip></span> : null}
                <PromptInputTextarea className="min-w-32 basis-40 border-0 bg-transparent px-1 focus:border-transparent focus:ring-0" id="assistant-message" name="system-helper-message" autoComplete="off" value={draft} onValueChange={(value) => { setDraft(value); setSlashDismissed(false); setMentionDismissed(false); setActiveCommandIndex(0); setActiveMentionIndex(0); }} onFocus={() => setOpen(true)} onKeyDown={handleComposerKeyDown} placeholder={waitingForInput ? t('assistant:composer.answerPlaceholder') : activeSubSession ? t('assistant:composer.followUpPlaceholder', { agent: activeSubSession.agentName }) : t('assistant:composer.placeholder')} role="combobox" aria-expanded={commandMatches.length > 0 || mentionMenuOpen} rows={1} />
              </div></PopoverAnchor>
              <PopoverContent side="top" align="start" className="w-[min(420px,calc(100vw-24px))] p-1" onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()}>
                {mentionMenuOpen ? <AgentMentionMenu agents={mentionMatches} activeIndex={activeMentionIndex} onActiveIndex={setActiveMentionIndex} onSelect={selectMention} /> : <div role="listbox" aria-label={t('assistant:commands.menuLabel')}>{commandMatches.map((command, index) => { const Icon = command.icon; return <button key={command.value} type="button" role="option" aria-selected={index === activeCommandIndex} className={cn('flex w-full items-start gap-3 rounded-md px-3 py-2 text-left', surfaceInteraction, focusRingInset, index === activeCommandIndex ? 'bg-brand-subtle' : 'hover:bg-surface-subtle')} onPointerDown={(event) => event.preventDefault()} onPointerMove={() => setActiveCommandIndex(index)} onClick={() => runCommand(command.value)}><Icon className="mt-0.5 size-4 shrink-0 text-brand" /><span><span className="block font-mono text-[13px] font-medium">{command.value}</span><span className="mt-0.5 block text-xs text-muted-foreground">{t(`assistant:${command.descriptionKey}`)}</span></span></button>; })}</div>}
              </PopoverContent>
            </Popover>
            <Tooltip><TooltipTrigger asChild><PromptInputSubmit className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md bg-brand text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50" status={running && !selectedAgent ? 'streaming' : busy ? 'submitted' : 'idle'} aria-label={running && !selectedAgent ? t('assistant:composer.stop') : t('assistant:composer.send')} disabled={running && !selectedAgent ? busy : !draft.trim() || busy || (!activeSubSession && !selectedAgent && !isConfigured)} onStop={() => void cancelExecution()}>{running && !selectedAgent ? <Square className="size-3.5 fill-current" /> : busy ? <LoaderCircle className="size-4 motion-safe:animate-spin" /> : <ArrowUp className="size-4" />}</PromptInputSubmit></TooltipTrigger><TooltipContent>{running && !selectedAgent ? t('assistant:composer.stop') : t('assistant:composer.send')}</TooltipContent></Tooltip>
          </PromptInput>
        ) : (
          <Link to="/agents/$agentId" params={{ agentId: SYSTEM_HELPER_CHAT_ID }} className={cn('flex min-h-12 items-center gap-2 px-3 text-[13px] font-medium hover:bg-surface-subtle', surfaceInteraction, focusRingInset)}><ShieldAlert className="size-4 shrink-0 text-brand" /><span className="min-w-0 flex-1">{t('assistant:composer.configure')}</span><ChevronRight className="size-4 text-muted-foreground" /></Link>
        )}
      </div> : null}
    </div>
  );
}

function SubAgentBand({ sessions, activeId, onSelect }: { sessions: AgentSubSessionView[]; activeId: string | null; onSelect: (session: AgentSubSessionView) => void }) {
  const { t } = useTranslation('assistant');
  return <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-3 py-2" aria-label={t('subAgents.label')}>
    <span className="shrink-0 text-xs font-semibold text-muted-foreground">{t('subAgents.label')}</span>
    <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
      {sessions.map((session) => {
        const StatusIcon = session.status === 'running' ? LoaderCircle : session.status === 'completed' ? CheckCircle2 : session.status === 'cancelled' ? Ban : CircleX;
        return <button key={session.id} type="button" className={cn('flex h-8 max-w-64 shrink-0 items-center gap-2 rounded-md border px-2 text-left text-[13px]', surfaceInteraction, focusRingInset, activeId === session.id ? 'border-brand bg-brand-subtle' : 'border-border bg-surface hover:bg-surface-subtle')} aria-current={activeId === session.id ? 'true' : undefined} onClick={() => onSelect(session)}>
          <span className="flex size-5 shrink-0 items-center justify-center rounded-sm border border-border bg-background text-[10px] font-semibold">{session.agentInitials}</span>
          <span className="min-w-0 truncate font-medium">{session.agentName}</span>
          <StatusIcon className={cn('size-3.5 shrink-0', session.status === 'running' && 'motion-safe:animate-spin', session.status === 'failed' && 'text-danger')} aria-hidden="true" />
          <span className="sr-only">{t(`status.${session.status}`)}</span>
          {session.unread ? <Badge variant="brand" className="shrink-0 px-1.5">{t('subAgents.unread')}</Badge> : null}
        </button>;
      })}
    </div>
  </div>;
}

function AgentMentionMenu({ agents, activeIndex, onActiveIndex, onSelect }: { agents: AgentView[]; activeIndex: number; onActiveIndex: (index: number) => void; onSelect: (agent: AgentView) => void }) {
  const { t } = useTranslation('assistant');
  return <div role="listbox" aria-label={t('mentions.menuLabel')}>
    {agents.length === 0 ? <p className="px-3 py-2 text-[13px] text-muted-foreground">{t('mentions.empty')}</p> : agents.map((agent, index) => <button key={agent.id} type="button" role="option" aria-selected={index === activeIndex} className={cn('flex w-full items-center gap-3 rounded-md px-3 py-2 text-left', surfaceInteraction, focusRingInset, index === activeIndex ? 'bg-brand-subtle' : 'hover:bg-surface-subtle')} onPointerDown={(event) => event.preventDefault()} onPointerMove={() => onActiveIndex(index)} onClick={() => onSelect(agent)}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-xs font-semibold">{agent.initials}</span>
      <span className="min-w-0"><span className="block truncate text-sm font-medium">{agent.name}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{agent.responsibility}</span></span>
    </button>)}
  </div>;
}

function StarterPane({ onSelect }: { onSelect: (prompt: string) => void }) {
  const { t } = useTranslation('assistant');
  const starters = ['provider', 'skill', 'mcp', 'agent'] as const;
  return <div className="my-auto py-6"><div className="mb-5 flex items-center gap-3"><span className="flex size-9 items-center justify-center rounded-md border border-border bg-surface"><MessageSquareText className="size-[18px] text-brand" /></span><div><p className="text-sm font-semibold">{t('starters.title')}</p><p className="mt-0.5 text-[13px] text-muted-foreground">{t('messages.welcome')}</p></div></div><div className="grid gap-2 sm:grid-cols-2">{starters.map((starter) => <button key={starter} type="button" className={cn('min-h-[72px] rounded-md border border-border bg-surface p-3 text-left hover:border-foreground/20 hover:bg-surface-subtle', surfaceInteraction, focusRing)} onClick={() => onSelect(t(`starters.${starter}.prompt`))}><span className="block text-sm font-medium">{t(`starters.${starter}.title`)}</span><span className="mt-1 block text-[13px] leading-5 text-muted-foreground">{t(`starters.${starter}.description`)}</span></button>)}</div></div>;
}

function MessageRow({ message, assistantName }: { message: AgentExecutionView['messages'][number]; assistantName?: string }) {
  const { t } = useTranslation('assistant');
  if (message.role === 'user') return <Message from="user" aria-label={t('speaker.you')}><MessageContent className="max-w-[min(78%,640px)] rounded-md bg-surface-subtle px-3 py-2.5"><p className="whitespace-pre-wrap break-words text-sm leading-6">{message.content}</p></MessageContent></Message>;
  return <Message from="assistant" aria-label={assistantName ?? t('speaker.assistant')}><div className="flex items-start gap-3"><span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface">{assistantName ? <Bot className="size-4 text-brand" /> : <MessageSquareText className="size-4 text-brand" />}</span><MessageContent className="flex-1 pt-0.5"><MessageResponse content={message.content} /></MessageContent></div></Message>;
}

function QuestionRow({ question }: { question: NonNullable<AgentExecutionView['pendingQuestion']> }) {
  return <div className="my-3 border-l-2 border-brand pl-3" role="status"><p className="text-sm font-medium">{question.question}</p>{question.options.length > 0 ? <p className="mt-1 text-xs text-muted-foreground">{question.options.join(' · ')}</p> : null}</div>;
}

function WorkingRow() {
  const { t } = useTranslation('assistant');
  return <div className="flex items-center gap-3 py-4 text-[13px] text-muted-foreground" role="status"><span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface"><LoaderCircle className="size-4 text-brand motion-safe:animate-spin" /></span><span>{t('execution.working')}</span></div>;
}

function CancelledRow() {
  const { t } = useTranslation('assistant');
  return <div className="flex items-center gap-3 py-4 text-[13px] text-muted-foreground" role="status"><span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface"><Ban className="size-4" /></span><span>{t('execution.cancelled')}</span></div>;
}

function FailureRow({ execution, message, onRetry, retryDisabled, locale }: { execution: AgentExecutionView | null; message: string; onRetry: () => void; retryDisabled: boolean; locale: AppLocale }) {
  const { t } = useTranslation('assistant');
  if (!execution) return null;
  return <div className="flex items-start gap-3 py-4 text-[13px] text-danger" role="alert"><span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-danger/40 bg-danger/10"><CircleX className="size-4" /></span><div className="min-w-0 flex-1 pt-1.5"><p>{message}</p><div className="mt-2 flex flex-wrap items-center gap-3"><Button type="button" variant="link" size="sm" className="h-auto px-0 text-danger" disabled={retryDisabled} onClick={onRetry}><RefreshCw className="mr-1 size-3.5" />{t('execution.retry')}</Button><details className="text-xs text-muted-foreground"><summary className="cursor-pointer select-none">{t('execution.diagnostics')}</summary><dl className="mt-2 grid gap-1 font-mono"><div><dt className="inline font-sans">{t('execution.id')}: </dt><dd className="inline break-all">{execution.id}</dd></div><div><dt className="inline font-sans">{t('execution.phase')}: </dt><dd className="inline">{execution.phase}</dd></div><div><dt className="inline font-sans">{t('execution.errorCode')}: </dt><dd className="inline">{execution.errorCode ?? t('execution.none')}</dd></div><div><dt className="inline font-sans">{t('execution.updated')}: </dt><dd className="inline font-sans">{formatDateTime(new Date(execution.updatedAt), locale)}</dd></div></dl></details></div></div></div>;
}

function ToolCallPanel({ call }: { call: AgentToolCallView }) {
  const { t } = useTranslation('assistant');
  const [expanded, setExpanded] = useState(false);
  const finished = call.status === 'completed' || call.status === 'failed' || call.status === 'cancelled';
  const resource = call.result?.type === 'resource' ? call.result : null;
  const scriptName = call.scriptPath?.split('/').pop() || t('tool.script');
  const variant = call.status === 'completed' ? 'success' : call.status === 'running' ? 'brand' : call.status === 'cancelled' ? 'neutral' : 'danger';
  return <article className="my-2 border-l-2 border-warning bg-surface-subtle" aria-label={t('tool.label')}>
    <button type="button" className={cn('flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left hover:bg-background/50', surfaceInteraction, focusRingInset)} aria-expanded={expanded} aria-label={expanded ? t('tool.collapse') : t('tool.expand')} onClick={() => setExpanded((value) => !value)}>
      <FileCode2 className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{call.skillName || t('tool.label')} <span className="font-mono text-xs font-normal text-muted-foreground">/ {scriptName}</span></span>
      {finished && call.exitCode !== null ? <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{t('tool.exitCode', { code: call.exitCode })}</span> : null}
      <Badge variant={variant}>{t(`tool.status.${call.status}`)}</Badge>
      {expanded ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
    </button>
    {expanded ? <div className="border-t border-border px-3 pb-3 pt-2.5">
      <dl className="grid gap-3 text-xs sm:grid-cols-2"><div><dt className="font-medium text-muted-foreground">{t('tool.script')}</dt><dd className="mt-1 break-all font-mono">{call.scriptPath}</dd></div><div><dt className="font-medium text-muted-foreground">{t('tool.workingDirectory')}</dt><dd className="mt-1 break-all font-mono">{call.workingDirectory}</dd></div><div><dt className="font-medium text-muted-foreground">{t('tool.toolCallId')}</dt><dd className="mt-1 break-all font-mono">{call.id}</dd></div><div><dt className="font-medium text-muted-foreground">{t('tool.commandExecutionId')}</dt><dd className="mt-1 break-all font-mono">{call.commandExecutionId || t('tool.none')}</dd></div><div className="sm:col-span-2"><dt className="font-medium text-muted-foreground">{t('tool.arguments')}</dt><dd><pre className="mt-1 overflow-x-auto rounded-md border border-border bg-background p-2.5 font-mono"><code>{JSON.stringify(call.arguments)}</code></pre></dd></div></dl>
      <p className="mt-3 flex items-start gap-2 text-[13px] text-warning"><ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{t('tool.warning')}</p>
      {finished ? <div className="mt-3"><p className="text-xs font-medium text-muted-foreground">{t('tool.output', { code: call.exitCode ?? t('tool.noExitCode') })}</p><pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border bg-background p-2.5 font-mono text-xs"><code>{call.output || t('tool.noOutput')}</code></pre></div> : null}
      {resource ? <Button asChild type="button" variant="link" size="sm" className="mt-2 h-auto px-0"><a href={resource.route}>{resource.resourceType === 'provider' ? t('tool.openSecureProvider') : t('tool.openResource')}<ChevronRight className="size-3.5" /></a></Button> : null}
    </div> : null}
  </article>;
}

function HistoryPane({ archived, loading, onResume, onRemove }: { archived: ArchivedExecution[]; loading: boolean; onResume: (item: ArchivedExecution) => void; onRemove: (id: string) => void }) {
  const { t } = useTranslation('assistant');
  return <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5"><div className="flex items-center gap-3 border-b border-border pb-4"><span className="flex size-9 items-center justify-center rounded-md border border-border bg-surface"><History className="size-[18px] text-brand" /></span><div><p className="text-sm font-semibold">{t('history.title')}</p><p className="mt-0.5 text-[13px] text-muted-foreground">{t('history.description')}</p></div></div>{loading ? <p className="py-8 text-center text-sm text-muted-foreground">{t('execution.loading')}</p> : archived.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">{t('history.empty')}</p> : <div className="divide-y divide-border">{archived.map((item) => <div key={item.id} className="flex items-center gap-3 py-3"><button type="button" className={cn('min-w-0 flex-1 rounded-sm text-left hover:text-brand', surfaceInteraction, focusRing)} onClick={() => onResume(item)}><span className="block truncate text-sm font-medium">{item.label}</span><span className="mt-1 block text-xs text-muted-foreground">{new Date(item.archivedAt).toLocaleString()}</span></button><Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-compact" aria-label={t('history.remove')} onClick={() => onRemove(item.id)}><Ban className="size-4" /></Button></TooltipTrigger><TooltipContent>{t('history.remove')}</TooltipContent></Tooltip></div>)}</div>}</div>;
}

type ExecutionLogLabels = {
  title: string;
  generated: string;
  executionId: string;
  phase: string;
  errorCode: string;
  status: string;
  incomplete: string;
  reason: string;
  cancelledReason: string;
  transcript: string;
  noMessages: string;
  user: string;
  assistant: string;
  activity: string;
  noActivity: string;
  skill: string;
  script: string;
  toolCallId: string;
  commandExecutionId: string;
  exitCode: string;
  statuses: Record<AgentExecutionView['status'], string>;
};

function escapeMarkdownText(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('=', '&#61;')
    .replace(/([\\`*_[\]{}()#+\-.!|~])/g, '\\$1');
}

function apiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
}

function protectAssistantMarkdown(value: string) {
  let openFence: { character: string; length: number } | null = null;
  const lines: string[] = [];
  for (const line of value.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!openFence) openFence = { character: marker[0], length: marker.length };
      else if (marker[0] === openFence.character && marker.length >= openFence.length) openFence = null;
      lines.push(line);
      continue;
    }
    if (openFence) {
      lines.push(line);
      continue;
    }
    const protectedLine = line
      .replace(/^(\s{0,3})(#{1,6})(?=\s|$)/, (_match, indent: string, hashes: string) => `${indent}${'#'.repeat(Math.max(4, hashes.length))}`)
      .replaceAll('<', '&lt;');
    if (/^\s*=+\s*$/.test(protectedLine)) lines.push(protectedLine.replaceAll('=', '&#61;'));
    else if (/^\s*-{2,}\s*$/.test(protectedLine)) lines.push(protectedLine.replaceAll('-', '\\-'));
    else lines.push(protectedLine);
  }
  if (openFence) lines.push('', openFence.character.repeat(openFence.length));
  return lines.join('\n');
}

function downloadExecutionLog(execution: AgentExecutionView, labels: ExecutionLogLabels, locale: AppLocale, executionError: string) {
  const generatedAt = new Date();
  const lines = [
    `# ${labels.title}`,
    '',
    `- **${labels.generated}:** ${formatDateTime(generatedAt, locale)}`,
    `- **${labels.executionId}:** ${execution.id}`,
    `- **${labels.status}:** ${labels.statuses[execution.status]}`,
    `- **${labels.phase}:** ${execution.phase}`,
    `- **${labels.errorCode}:** ${execution.errorCode ?? 'none'}`,
    '',
  ];
  if (execution.status === 'running') lines.push(`> ${labels.incomplete}`, '');
  if (executionError) lines.push(`- **${labels.reason}:** ${escapeMarkdownText(executionError)}`, '');
  else if (execution.status === 'cancelled') lines.push(`- **${labels.reason}:** ${escapeMarkdownText(labels.cancelledReason)}`, '');
  lines.push(`## ${labels.transcript}`, '');
  if (execution.messages.length === 0) lines.push(labels.noMessages, '');
  else {
    execution.messages.forEach((message, index) => {
      const speaker = message.role === 'user' ? labels.user : labels.assistant;
      const content = message.role === 'user' ? escapeMarkdownText(message.content.replace(/\r\n?/g, '\n')) : protectAssistantMarkdown(message.content);
      lines.push(`### ${index + 1}. ${speaker}`, '', content, '');
    });
  }
  lines.push(`## ${labels.activity}`, '');
  if (execution.toolCalls.length === 0) lines.push(labels.noActivity, '');
  else {
    for (const call of execution.toolCalls) {
      const pathSegments = call.scriptPath?.split(/[\\/]/).filter(Boolean) ?? [];
      const skillName = escapeMarkdownText(call.skillName || labels.skill);
      const scriptName = escapeMarkdownText(pathSegments[pathSegments.length - 1] || labels.script);
      const exitCode = call.exitCode === null ? '' : ` | **${labels.exitCode}:** ${call.exitCode}`;
      const identifiers = ` | **${labels.toolCallId}:** ${call.id}${call.commandExecutionId ? ` | **${labels.commandExecutionId}:** ${call.commandExecutionId}` : ''}`;
      lines.push(`- **${skillName}** | **${labels.script}:** ${scriptName} | **${labels.status}:** ${labels.statuses[call.status]}${exitCode}${identifiers}`);
    }
    lines.push('');
  }
  const blob = new Blob([`${lines.join('\n').trimEnd()}\n`], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `worklite-system-helper-${generatedAt.toISOString().replaceAll(':', '-')}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export { AgentChat };
