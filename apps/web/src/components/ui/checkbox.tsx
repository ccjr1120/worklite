import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { focusRing, surfaceInteraction } from '@/components/ui/interaction';

function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'peer size-[18px] shrink-0 rounded-sm border border-input bg-surface hover:border-foreground/30 disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:opacity-60 disabled:hover:border-input data-[state=checked]:border-brand data-[state=checked]:bg-brand data-[state=checked]:text-brand-foreground data-[state=checked]:hover:border-brand-hover data-[state=checked]:hover:bg-brand-hover disabled:data-[state=checked]:hover:border-brand disabled:data-[state=checked]:hover:bg-brand',
        surfaceInteraction,
        focusRing,
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <Check className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
