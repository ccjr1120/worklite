import * as LabelPrimitive from '@radix-ui/react-label';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('text-xs font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-50', className)}
      {...props}
    />
  );
}

export { Label };
