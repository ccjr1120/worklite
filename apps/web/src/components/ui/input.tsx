import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { controlInteraction, focusRing } from '@/components/ui/interaction';
import { useFieldDescription } from '@/components/ui/field';

function Input({ className, type, 'aria-describedby': describedBy, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const fieldDescription = useFieldDescription(describedBy);
  return (
    <input
      type={type}
      aria-describedby={fieldDescription}
      className={cn(
        'flex h-[38px] w-full min-w-0 truncate rounded-md border border-input bg-surface px-3 text-sm text-foreground shadow-xs placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted-foreground disabled:opacity-70 disabled:shadow-none',
        controlInteraction,
        focusRing,
        className,
      )}
      {...props}
    />
  );
}

export { Input };
