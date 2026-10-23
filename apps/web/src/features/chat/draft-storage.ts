// A chat draft has to survive leaving the Chat route and reloading the app, so it lives in
// localStorage instead of component state. Drafts are keyed per conversation; the composer
// that has not created a conversation yet uses a reserved key until the server returns its id.
const DRAFT_STORAGE_PREFIX = 'worklite.chat.draft.';

// Real ids and the new-conversation slot get different namespaces so a server id can
// never collide with the reserved slot.
function draftStorageKey(conversationId: string | null): string {
  return `${DRAFT_STORAGE_PREFIX}${conversationId === null ? 'new' : `conversation.${conversationId}`}`;
}

/**
 * Reads the stored draft. `null` means storage is unavailable (for example a restricted
 * browser profile), which lets the caller fall back to its in-memory copy; an empty string
 * means the conversation has no stored draft.
 */
export function readChatDraft(conversationId: string | null): string | null {
  try {
    return window.localStorage.getItem(draftStorageKey(conversationId));
  } catch {
    return null;
  }
}

export function writeChatDraft(conversationId: string | null, draft: string): void {
  try {
    if (draft) window.localStorage.setItem(draftStorageKey(conversationId), draft);
    else window.localStorage.removeItem(draftStorageKey(conversationId));
  } catch {
    // Private mode or a full quota keeps the in-memory draft working for this session.
  }
}

/** The server created a conversation from the new-conversation composer: retire its draft. */
export function clearNewConversationDraft(): void {
  writeChatDraft(null, '');
}
