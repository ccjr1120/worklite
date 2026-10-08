import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { controlInteraction, focusRing, surfaceInteraction } from '@/components/ui/interaction';
import { useFieldDescription } from '@/components/ui/field';

function Select({ ...props }: ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root {...props} />;
}

function SelectValue({ ...props }: ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value {...props} />;
}

// The value span truncates on one line; the chevron never shrinks, so long values
// end in an ellipsis instead of wrapping or running under the icon.
function SelectTrigger({ className, children, 'aria-describedby': describedBy, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  const fieldDescription = useFieldDescription(describedBy);
  return (
    <SelectPrimitive.Trigger
      aria-describedby={fieldDescription}
      className={cn(
        'group flex h-[38px] w-full min-w-0 items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-surface px-3 text-left text-sm shadow-xs data-[placeholder]:text-muted-foreground disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted-foreground disabled:opacity-70 disabled:shadow-none [&>span]:min-w-0 [&>span]:truncate',
        controlInteraction,
        focusRing,
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-[var(--ease-out)] group-data-[state=open]:rotate-180" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

// A field-anchored overlay matches its trigger exactly; long options truncate.
function SelectContent({ className, children, position = 'popper', sideOffset = 6, ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        className={cn(
          'wl-select-content relative z-50 max-h-[min(20rem,var(--radix-select-content-available-height))] overflow-hidden rounded-lg border border-border bg-surface-raised text-foreground shadow-md outline-none',
          position === 'popper' && 'w-[var(--radix-select-trigger-width)]',
          position !== 'popper' && 'min-w-[var(--radix-select-trigger-width)]',
          className,
        )}
        position={position}
        sideOffset={sideOffset}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'relative flex h-9 w-full min-w-0 cursor-pointer select-none items-center rounded-sm pl-8 pr-2.5 text-sm outline-none data-[highlighted]:bg-surface-subtle data-[state=checked]:font-medium data-[disabled]:pointer-events-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        surfaceInteraction,
        className,
      )}
      title={typeof children === 'string' ? children : undefined}
      {...props}
    >
      <span className="absolute left-2.5 flex size-4 items-center justify-center text-brand">
        <SelectPrimitive.ItemIndicator>
          <Check className="wl-check-pop size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <span className="min-w-0 truncate"><SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText></span>
    </SelectPrimitive.Item>
  );
}

function SelectGroup({ ...props }: ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group {...props} />;
}

function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label className={cn('truncate px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground', className)} {...props} />;
}

function SelectSeparator({ className, ...props }: ComponentProps<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}

export { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue };
