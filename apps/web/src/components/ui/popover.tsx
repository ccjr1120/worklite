import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

function Popover({ ...props }: ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root {...props} />;
}

function PopoverTrigger({ ...props }: ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger {...props} />;
}

function PopoverAnchor({ ...props }: ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor {...props} />;
}

// `matchTrigger` sizes a field-anchored popover to its trigger or anchor exactly.
function PopoverContent({
  className,
  align = 'center',
  sideOffset = 6,
  matchTrigger = false,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content> & { matchTrigger?: boolean }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'wl-overlay z-50 rounded-lg border border-border bg-surface-raised p-3 text-sm text-foreground shadow-md outline-none',
          matchTrigger ? 'w-[var(--radix-popover-trigger-width)]' : 'w-72',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
