import type { Ref, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { controlInteraction, focusRing } from '@/components/ui/interaction';
import { useFieldDescription } from '@/components/ui/field';

// `field-sizing: content` lets the textarea grow with its value; min/max heights bound it.
function Textarea({ className, 'aria-describedby': describedBy, ref, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  const fieldDescription = useFieldDescription(describedBy);
  return (
    <textarea
      ref={ref}
      aria-describedby={fieldDescription}
      className={cn(
        'flex min-h-24 w-full rounded-md border border-input bg-surface px-3 py-2.5 text-sm leading-6 text-foreground shadow-xs [field-sizing:content] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted-foreground disabled:opacity-70 disabled:shadow-none',
        controlInteraction,
        focusRing,
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
