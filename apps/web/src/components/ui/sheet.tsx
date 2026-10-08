import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { focusRing } from '@/components/ui/interaction';

function Sheet({ ...props }: ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root {...props} />;
}

function SheetOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return <DialogPrimitive.Overlay className={cn('wl-backdrop fixed inset-0 z-50', className)} {...props} />;
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
          'fixed z-50 flex flex-col bg-surface-raised shadow-lg outline-none',
          side === 'right' && 'wl-sheet-right inset-y-0 right-0 h-full w-full border-l border-border sm:max-w-md',
          side === 'left' && 'wl-sheet-left inset-y-0 left-0 h-full w-full border-r border-border sm:max-w-[240px]',
          side === 'bottom' && 'wl-sheet-bottom inset-x-0 bottom-0 h-[70vh] rounded-t-2xl border-t border-border',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className={cn('wl-press absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-subtle hover:text-foreground active:bg-border', focusRing)}>
          <X className="size-4" />
          <span className="sr-only">{t('actions.close')}</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 p-5 pr-12', className)} {...props} />;
}

function SheetTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-base font-semibold', className)} {...props} />;
}

export { Sheet, SheetContent, SheetHeader, SheetTitle };
