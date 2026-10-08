import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { focusRing, surfaceInteraction } from '@/components/ui/interaction';

function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-border p-0.5 hover:bg-foreground/20 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-border data-[state=checked]:bg-brand data-[state=checked]:hover:bg-brand-hover disabled:data-[state=checked]:hover:bg-brand',
        surfaceInteraction,
        focusRing,
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-[18px] rounded-full bg-white shadow-sm transition-transform duration-[260ms] ease-[var(--ease-spring)] data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
