import * as TabsPrimitive from '@radix-ui/react-tabs';
import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { focusRingInset } from '@/components/ui/interaction';

type TabsVariant = 'underline' | 'segmented';

function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root className={cn('flex flex-col gap-5', className)} {...props} />;
}

// Measures the selected trigger and glides one shared indicator to it, so selection
// moves instead of jumping. Works for Radix triggers and plain role="tab" buttons.
function useSlidingIndicator<T extends HTMLElement>() {
  const listRef = useRef<T>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const active = list.querySelector<HTMLElement>('[role="tab"][data-state="active"], [role="tab"][aria-selected="true"]');
      setIndicator(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
    };
    measure();
    const mutation = new MutationObserver(measure);
    mutation.observe(list, { attributes: true, subtree: true, attributeFilter: ['data-state', 'aria-selected'] });
    const resize = new ResizeObserver(measure);
    resize.observe(list);
    return () => { mutation.disconnect(); resize.disconnect(); };
  }, []);

  return { listRef, indicator };
}

const listClasses: Record<TabsVariant, string> = {
  underline: 'relative flex h-11 min-w-0 items-end gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]',
  segmented: 'relative inline-flex h-9 items-center gap-0.5 rounded-md bg-surface-subtle p-1',
};

const triggerClasses: Record<TabsVariant, string> = {
  underline: 'relative z-[1] inline-flex h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap px-3 text-[13px] font-medium text-muted-foreground transition-colors duration-[140ms] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 data-[state=active]:text-foreground aria-selected:text-foreground aria-[current=page]:text-foreground [&_svg]:size-4 [&_svg]:shrink-0',
  segmented: 'relative z-[1] inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-3 text-[13px] font-medium text-muted-foreground transition-colors duration-[140ms] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 data-[state=active]:text-foreground aria-selected:text-foreground aria-[current=page]:text-foreground [&_svg]:size-4 [&_svg]:shrink-0',
};

function TabsIndicator({ variant, indicator }: { variant: TabsVariant; indicator: { left: number; width: number } | null }) {
  if (!indicator) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute transition-[left,width] duration-[260ms] ease-[var(--ease-out)]',
        variant === 'underline' ? 'bottom-0 h-0.5 rounded-full bg-brand' : 'top-1 bottom-1 rounded-sm bg-surface shadow-xs',
      )}
      style={{ left: indicator.left, width: indicator.width }}
    />
  );
}

function TabsList({ className, variant = 'underline', children, ...props }: ComponentProps<typeof TabsPrimitive.List> & { variant?: TabsVariant }) {
  const { listRef, indicator } = useSlidingIndicator<HTMLDivElement>();
  return (
    <TabsPrimitive.List ref={listRef} data-variant={variant} className={cn('group/tabs', listClasses[variant], className)} {...props}>
      {children}
      <TabsIndicator variant={variant} indicator={indicator} />
    </TabsPrimitive.List>
  );
}

function TabsTrigger({ className, variant = 'underline', ...props }: ComponentProps<typeof TabsPrimitive.Trigger> & { variant?: TabsVariant }) {
  return <TabsPrimitive.Trigger className={cn(triggerClasses[variant], focusRingInset, className)} {...props} />;
}

function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('wl-fade outline-none', className)} {...props} />;
}

// For routed tab bars that manage selection themselves (role="tab" buttons).
function TabBar({ className, variant = 'underline', children, ...props }: ComponentProps<'div'> & { variant?: TabsVariant }) {
  const { listRef, indicator } = useSlidingIndicator<HTMLDivElement>();
  return (
    <div ref={listRef} role="tablist" className={cn(listClasses[variant], className)} {...props}>
      {children}
      <TabsIndicator variant={variant} indicator={indicator} />
    </div>
  );
}

// Link-based section navigation that looks like tabs; the active link carries aria-current="page".
function TabNav({ className, variant = 'underline', children, ...props }: ComponentProps<'nav'> & { variant?: TabsVariant }) {
  const listRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const active = list.querySelector<HTMLElement>('[aria-current="page"]');
      setIndicator(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
    };
    measure();
    const mutation = new MutationObserver(measure);
    mutation.observe(list, { attributes: true, subtree: true, attributeFilter: ['aria-current'] });
    const resize = new ResizeObserver(measure);
    resize.observe(list);
    return () => { mutation.disconnect(); resize.disconnect(); };
  }, []);
  return (
    <nav ref={listRef} className={cn(listClasses[variant], className)} {...props}>
      {children}
      <TabsIndicator variant={variant} indicator={indicator} />
    </nav>
  );
}

function tabTriggerClassName(variant: TabsVariant = 'underline', className?: string) {
  return cn(triggerClasses[variant], focusRingInset, className);
}

// A segmented radio group: role="radio" children with aria-checked; the selected pill slides.
function SegmentedRadioGroup({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const active = list.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
      setIndicator(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
    };
    measure();
    const mutation = new MutationObserver(measure);
    mutation.observe(list, { attributes: true, subtree: true, attributeFilter: ['aria-checked'] });
    const resize = new ResizeObserver(measure);
    resize.observe(list);
    return () => { mutation.disconnect(); resize.disconnect(); };
  }, []);
  return (
    <div ref={listRef} role="radiogroup" aria-label={label} className={cn('relative inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md bg-surface-subtle p-1 [scrollbar-width:none]', className)}>
      {children}
      <TabsIndicator variant="segmented" indicator={indicator} />
    </div>
  );
}

export { SegmentedRadioGroup, TabBar, TabNav, Tabs, TabsContent, TabsList, TabsTrigger, tabTriggerClassName };
