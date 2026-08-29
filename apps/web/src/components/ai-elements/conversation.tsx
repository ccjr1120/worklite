import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type ConversationProps = ComponentProps<'div'>;

const Conversation = forwardRef<HTMLDivElement, ConversationProps>(({ className, ...props }, ref) => (
  <div ref={ref} role="log" className={cn('relative min-h-0 flex-1 overflow-y-auto', className)} {...props} />
));
Conversation.displayName = 'Conversation';

type ConversationContentProps = ComponentProps<'div'>;

function ConversationContent({ className, ...props }: ConversationContentProps) {
  return <div className={cn('flex min-h-full flex-col py-5', className)} {...props} />;
}

function ConversationEmptyState({ children, className, ...props }: ComponentProps<'div'> & { children?: ReactNode }) {
  return <div className={cn('flex size-full flex-col items-center justify-center gap-3 p-8 text-center', className)} {...props}>{children}</div>;
}

export { Conversation, ConversationContent, ConversationEmptyState };
