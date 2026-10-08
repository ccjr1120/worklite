import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

type PromptInputProps = ComponentProps<'form'>;

function PromptInput({ className, ...props }: PromptInputProps) {
  return <form autoComplete="off" className={cn('flex w-full min-w-0 items-center gap-2 p-2', className)} {...props} />;
}

type PromptInputTextareaProps = Omit<ComponentProps<'textarea'>, 'onChange'> & {
  value: string;
  onValueChange: (value: string) => void;
};

function PromptInputTextarea({ className, onValueChange, ...props }: PromptInputTextareaProps) {
  return <textarea className={cn('min-h-10 max-h-48 w-full min-w-0 flex-1 resize-none rounded-md border border-border bg-surface px-3 py-2 text-sm leading-6 outline-none [field-sizing:content] placeholder:text-muted-foreground focus:border-brand focus:ring-[3px] focus:ring-ring/25', className)} onChange={(event) => onValueChange(event.target.value)} {...props} />;
}

type PromptInputSubmitProps = ComponentProps<'button'> & { status?: 'idle' | 'submitted' | 'streaming' | 'error'; onStop?: () => void };

function PromptInputSubmit({ status = 'idle', onStop, children, ...props }: PromptInputSubmitProps) {
  const active = status === 'submitted' || status === 'streaming';
  return <button type={active && onStop ? 'button' : 'submit'} onClick={active && onStop ? onStop : undefined} {...props}>{children}</button>;
}

export { PromptInput, PromptInputTextarea, PromptInputSubmit };
