import { memo, type ComponentProps } from 'react';
import { StreamingMarkdown } from '@/components/ai/streaming-markdown';
import { cn } from '@/lib/utils';

type MessageProps = ComponentProps<'article'> & { from: 'user' | 'assistant' };

function Message({ from, className, ...props }: MessageProps) {
  return <article className={cn('flex w-full flex-col gap-2 py-3', from === 'user' ? 'items-end' : 'items-start', className)} {...props} />;
}

function MessageContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('min-w-0 max-w-full text-sm', className)} {...props} />;
}

// Memoized so an updating transcript (for example while a later message streams) does not
// re-render the markdown of messages whose content has not changed.
const MessageResponse = memo(function MessageResponse({
  content,
  streaming = false,
  className,
  enabled = true,
}: {
  content: string;
  streaming?: boolean;
  className?: string;
  enabled?: boolean;
}) {
  return <StreamingMarkdown content={content} streaming={streaming} className={className} enabled={enabled} />;
});

export { Message, MessageContent, MessageResponse };
