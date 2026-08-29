import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { focusRing, surfaceInteraction } from '@/components/ui/interaction';

function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-surface-subtle hover:border-foreground/15 hover:bg-border disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-transparent disabled:hover:bg-surface-subtle data-[state=checked]:bg-brand data-[state=checked]:hover:border-transparent data-[state=checked]:hover:bg-brand-hover disabled:data-[state=checked]:hover:bg-brand',
        surfaceInteraction,
        focusRing,
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-surface shadow-sm transition-transform duration-[120ms] data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5" />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
