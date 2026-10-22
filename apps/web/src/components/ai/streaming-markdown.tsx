import { Component, lazy, Suspense, type ReactNode } from 'react';
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

// A renderer failure (or a failed lazy chunk) must not take the surrounding card down: show the raw text instead.
class MarkdownBoundary extends Component<{ resetKey: string; fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous: { resetKey: string }) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
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

  const plain = <PlainTextMarkdown content={content} className={className} />;
  return (
    <MarkdownBoundary resetKey={content} fallback={plain}>
      <Suspense fallback={plain}>
        <StreamingMarkdownView content={content} streaming={streaming} className={className} />
      </Suspense>
    </MarkdownBoundary>
  );
}

export { StreamingMarkdown };
