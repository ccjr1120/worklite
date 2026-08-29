import type { TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { controlInteraction, focusRing } from '@/components/ui/interaction';

function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'flex min-h-24 w-full rounded-md border border-input bg-surface px-3 py-2 text-sm text-foreground shadow-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted-foreground disabled:opacity-70',
        controlInteraction,
        focusRing,
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
