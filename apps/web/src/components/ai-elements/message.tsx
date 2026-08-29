import type { ComponentProps } from 'react';
import { StreamingMarkdown } from '@/components/ai/streaming-markdown';
import { cn } from '@/lib/utils';

type MessageProps = ComponentProps<'article'> & { from: 'user' | 'assistant' };

function Message({ from, className, ...props }: MessageProps) {
  return <article className={cn('flex w-full flex-col gap-2 py-3', from === 'user' ? 'items-end' : 'items-start', className)} {...props} />;
}

function MessageContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('min-w-0 max-w-full text-sm', className)} {...props} />;
}

function MessageResponse({ content, streaming = false, className }: { content: string; streaming?: boolean; className?: string }) {
  return <StreamingMarkdown content={content} streaming={streaming} className={className} />;
}

export { Message, MessageContent, MessageResponse };
