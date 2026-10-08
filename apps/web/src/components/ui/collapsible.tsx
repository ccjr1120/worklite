import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

function Collapsible({ ...props }: ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root {...props} />;
}

function CollapsibleTrigger({ ...props }: ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger {...props} />;
}

// Disclosures animate their height instead of appearing.
function CollapsibleContent({ className, ...props }: ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return <CollapsiblePrimitive.CollapsibleContent className={cn('wl-collapsible', className)} {...props} />;
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
