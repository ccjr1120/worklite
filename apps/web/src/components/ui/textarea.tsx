import type { TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { controlInteraction, focusRing } from '@/components/ui/interaction';
import { useFieldDescription } from '@/components/ui/field';

function Textarea({ className, 'aria-describedby': describedBy, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const fieldDescription = useFieldDescription(describedBy);
  return (
    <textarea
      aria-describedby={fieldDescription}
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
