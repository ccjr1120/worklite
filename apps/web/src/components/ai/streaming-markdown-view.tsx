import { Streamdown } from 'streamdown';
import 'streamdown/styles.css';
import { cn } from '@/lib/utils';

type StreamingMarkdownViewProps = {
  content: string;
  streaming?: boolean;
  className?: string;
};

function StreamingMarkdownView({
  content,
  streaming = false,
  className,
}: StreamingMarkdownViewProps) {
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      isAnimating={streaming}
      parseIncompleteMarkdown={streaming}
      skipHtml
      dir="auto"
      controls={{ code: { copy: true }, table: { copy: true } }}
      className={cn(
        'min-w-0 break-words text-sm leading-6',
        '[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
        '[&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-lg [&_h1]:font-semibold',
        '[&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-semibold',
        '[&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-sm [&_h3]:font-semibold',
        '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5',
        '[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_li]:my-1 [&_li]:pl-0.5',
        '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
        '[&_a]:text-brand [&_a]:underline [&_a]:underline-offset-2',
        '[&_code]:font-mono [&_code]:text-[13px]',
        '[&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-surface-subtle [&_pre]:p-3',
        '[&_table]:text-[13px] [&_th]:font-semibold',
        '[&_hr]:my-4 [&_hr]:border-border',
        className,
      )}
    >
      {content}
    </Streamdown>
  );
}

export default StreamingMarkdownView;
