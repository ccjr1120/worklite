import { lazy, Suspense } from 'react';
import { cn } from '@/lib/utils';

type StreamingMarkdownProps = {
  content: string;
  streaming?: boolean;
  className?: string;
  enabled?: boolean;
};

const StreamingMarkdownView = lazy(() => import('./streaming-markdown-view'));

function PlainTextMarkdown({ content, className }: Pick<StreamingMarkdownProps, 'content' | 'className'>) {
  return <div className={cn('min-w-0 break-words whitespace-pre-wrap text-sm leading-6', className)}>{content}</div>;
}

function StreamingMarkdown({
  content,
  streaming = false,
  className,
  enabled = true,
}: StreamingMarkdownProps) {
  if (!enabled) {
    return <PlainTextMarkdown content={content} className={className} />;
  }

  return (
    <Suspense fallback={<PlainTextMarkdown content={content} className={className} />}>
      <StreamingMarkdownView content={content} streaming={streaming} className={className} />
    </Suspense>
  );
}

export { StreamingMarkdown };
