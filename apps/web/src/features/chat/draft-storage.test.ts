import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearNewConversationDraft, readChatDraft, writeChatDraft } from './draft-storage';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('chat draft storage', () => {
  it('round-trips a draft under its conversation id', () => {
    writeChatDraft('conversation-a', 'hello');

    expect(readChatDraft('conversation-a')).toBe('hello');
  });

  it('keeps drafts for different conversations isolated', () => {
    writeChatDraft('conversation-a', 'alpha');
    writeChatDraft('conversation-b', 'beta');

    expect(readChatDraft('conversation-a')).toBe('alpha');
    expect(readChatDraft('conversation-b')).toBe('beta');
  });

  it('stores the not-yet-created conversation under the reserved new key', () => {
    writeChatDraft(null, 'unsent idea');

    expect(window.localStorage.getItem('worklite.chat.draft.new')).toBe('unsent idea');
    expect(window.localStorage.getItem('worklite.chat.draft.conversation.new')).toBeNull();
    expect(readChatDraft(null)).toBe('unsent idea');
  });

  it('removes the entry when the draft becomes empty', () => {
    writeChatDraft('conversation-a', 'hello');
    writeChatDraft('conversation-a', '');

    expect(window.localStorage.getItem('worklite.chat.draft.conversation.conversation-a')).toBeNull();
    expect(readChatDraft('conversation-a')).toBeNull();
  });

  it('clears the new-conversation draft after the conversation is created', () => {
    writeChatDraft(null, 'sent text');
    clearNewConversationDraft();

    expect(readChatDraft(null)).toBeNull();
  });

  it('reports storage as unavailable instead of throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    expect(readChatDraft('conversation-a')).toBeNull();
    expect(() => writeChatDraft('conversation-a', 'hello')).not.toThrow();
  });
});
