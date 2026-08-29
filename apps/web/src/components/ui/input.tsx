import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { controlInteraction, focusRing } from '@/components/ui/interaction';

function Input({ className, type, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-surface px-3 text-sm text-foreground shadow-none placeholder:text-muted-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted-foreground disabled:opacity-70',
        controlInteraction,
        focusRing,
        className,
      )}
      {...props}
    />
  );
}

export { Input };
