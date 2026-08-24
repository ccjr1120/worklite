import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import type { ComponentProps } from 'react';

function Collapsible({ ...props }: ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root {...props} />;
}

function CollapsibleTrigger({ ...props }: ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger {...props} />;
}

function CollapsibleContent({ ...props }: ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return <CollapsiblePrimitive.CollapsibleContent {...props} />;
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
