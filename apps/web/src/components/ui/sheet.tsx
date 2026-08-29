import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { focusRing, surfaceInteraction } from '@/components/ui/interaction';

function Sheet({ ...props }: ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root {...props} />;
}

function SheetTrigger({ ...props }: ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger {...props} />;
}

function SheetClose({ ...props }: ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close {...props} />;
}

function SheetOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-background/70 duration-[200ms] motion-safe:data-[state=open]:animate-in motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  side = 'right',
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { side?: 'right' | 'left' | 'bottom' }) {
  const { t } = useTranslation('common');
  return (
    <DialogPrimitive.Portal>
      <SheetOverlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 flex flex-col bg-surface-raised shadow-lg outline-none duration-[200ms]',
          side === 'right' && 'inset-y-0 right-0 h-full w-full border-l border-border sm:max-w-md',
          side === 'left' && 'inset-y-0 left-0 h-full w-full border-r border-border sm:max-w-[232px]',
          side === 'bottom' && 'inset-x-0 bottom-0 h-[70vh] rounded-t-xl border-t border-border',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className={cn('absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-subtle hover:text-foreground active:bg-border', surfaceInteraction, focusRing)}>
          <X className="size-4" />
          <span className="sr-only">{t('actions.close')}</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 p-4 pr-12', className)} {...props} />;
}

function SheetTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-base font-semibold', className)} {...props} />;
}

function SheetDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-[13px] text-muted-foreground', className)} {...props} />;
}

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger };
