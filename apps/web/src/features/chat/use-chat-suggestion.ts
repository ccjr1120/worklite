import { useEffect, useMemo, useRef, useState } from 'react';
import { chatSuggestionContext, type AgentExecutionView, type ChatSuggestion, type ChatSuggestionResponse } from '@worklite/contracts';
import { api } from '@/api/client';

const STORAGE_KEY = 'worklite.chat.dismissed-suggestions';
const suggestionKey = (conversationId: string, suggestion: ChatSuggestion) => JSON.stringify([conversationId, suggestion.id, suggestion.text, suggestion.runIds]);

function readDismissed(): string[] {
  try {
    const saved: unknown = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((key): key is string => typeof key === 'string').slice(-256) : [];
  } catch { return []; }
}

export function useChatSuggestion(conversationId: string | null, execution: AgentExecutionView | null, enabled: boolean) {
  const context = useMemo(() => execution ? chatSuggestionContext(execution) : null, [execution]);
  // Equivalent SSE snapshots and the five-second poll must not restart an in-flight decision.
  const serializedContext = JSON.stringify(context);
  const executionId = execution?.id ?? null;
  const cache = useRef(new Map<string, ChatSuggestionResponse>());
  const [decision, setDecision] = useState<{ key: string; response: ChatSuggestionResponse } | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);
  const key = JSON.stringify([conversationId, executionId, context?.contextVersion]);
  const eligible = enabled && Boolean(conversationId && context?.candidates.length);

  useEffect(() => {
    if (!eligible || !executionId) return;
    const current = JSON.parse(serializedContext) as ReturnType<typeof chatSuggestionContext>;
    const remembered = cache.current.get(key);
    if (remembered) { setDecision({ key, response: remembered }); return; }
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 3_000);
    const fallback: ChatSuggestionResponse = { contextVersion: current.contextVersion, suggestion: current.candidates[0] ?? null, source: 'rules' };
    const load = async () => {
      let response: ChatSuggestionResponse;
      try {
        const result = await api.chatSuggestions(executionId, current.contextVersion, controller.signal);
        const candidate = result.suggestion;
        if (result.contextVersion !== current.contextVersion) return;
        // Only accept the exact rule candidates. Jev chooses; it cannot supply arbitrary
        // text, task ids or commands to the composer.
        response = { ...result, suggestion: candidate === null ? null : current.candidates.find((item) => item.id === candidate?.id && item.text === candidate.text
          && JSON.stringify(item.runIds) === JSON.stringify(candidate.runIds)) ?? fallback.suggestion };
      } catch { response = fallback; }
      finally { window.clearTimeout(timer); }
      if (cancelled) return;
      if (cache.current.size >= 32) cache.current.delete(cache.current.keys().next().value!);
      cache.current.set(key, response);
      setDecision({ key, response });
    };
    void load();
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [eligible, executionId, key, serializedContext]);

  const proposed = eligible && decision?.key === key ? decision.response.suggestion : null;
  const suggestion = proposed && !dismissed.includes(suggestionKey(conversationId!, proposed)) ? proposed : null;
  function dismiss() {
    if (!suggestion || !conversationId) return;
    const ignored = suggestionKey(conversationId, suggestion);
    setDismissed((previous) => {
      const next = [...previous.filter((item) => item !== ignored), ignored].slice(-256);
      try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* In-memory dismissal still applies. */ }
      return next;
    });
  }
  return { suggestion, dismiss };
}
