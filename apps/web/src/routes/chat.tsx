import { createFileRoute } from '@tanstack/react-router';
import { ChatWorkspace } from '@/features/chat';

export type ChatSearch = { view?: 'conversation' | 'channels' | 'configuration' | 'memories'; conversation?: string; agentId?: string; agentRunId?: string; agentExecutionId?: string };

export const Route = createFileRoute('/chat')({
  validateSearch: (search: Record<string, unknown>): ChatSearch => ({
    view: search.view === 'channels' || search.view === 'configuration' || search.view === 'memories' ? search.view : 'conversation',
    agentId: typeof search.agentId === 'string' ? search.agentId : undefined,
    agentRunId: typeof search.agentRunId === 'string' ? search.agentRunId : undefined,
    agentExecutionId: typeof search.agentExecutionId === 'string' ? search.agentExecutionId : undefined,
    conversation: typeof search.conversation === 'string' && search.conversation ? search.conversation : undefined,
  }),
  component: ChatWorkspace,
});
