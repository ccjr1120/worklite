import { ArrowDown } from 'lucide-react';
import { createContext, useContext, useEffect, type ComponentProps } from 'react';
import { useStickToBottom, type StickToBottomInstance } from 'use-stick-to-bottom';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

// The context carries the ref callback itself rather than the hook instance, so
// ConversationContent attaches it without reading a ref value during render.
const ContentRefContext = createContext<StickToBottomInstance['contentRef'] | null>(null);

type ConversationProps = ComponentProps<'div'> & { scrollToEndLabel: string; scrollToBottomKey?: number };

// The transcript sticks to the end while the reader is already there, and releases as
// soon as they scroll away. `use-stick-to-bottom` owns the resize observation, so
// streamed tokens extend the content without the container fighting the reader.
function Conversation({ className, children, scrollToEndLabel, scrollToBottomKey, ...props }: ConversationProps) {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({ initial: 'instant', resize: 'smooth' });
  useEffect(() => {
    if (scrollToBottomKey !== undefined) void scrollToBottom('instant');
  }, [scrollToBottomKey, scrollToBottom]);
  return (
    <ContentRefContext.Provider value={contentRef}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} role="log" className={cn('min-h-0 flex-1 overflow-y-auto', className)} {...props}>
          {children}
        </div>
        {isAtBottom ? null : (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="secondary"
                  size="icon-compact"
                  aria-label={scrollToEndLabel}
                  className="pointer-events-auto rounded-full shadow-md"
                  onClick={() => void scrollToBottom()}
                >
                  <ArrowDown className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{scrollToEndLabel}</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
    </ContentRefContext.Provider>
  );
}

type ConversationContentProps = ComponentProps<'div'>;

function ConversationContent({ className, ...props }: ConversationContentProps) {
  const contentRef = useContext(ContentRefContext);
  if (!contentRef) throw new Error('ConversationContent must be rendered inside Conversation.');
  return <div ref={contentRef} className={cn('flex min-h-full flex-col py-5', className)} {...props} />;
}

export { Conversation, ConversationContent };
