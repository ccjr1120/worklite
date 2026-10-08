import { Command as CommandPrimitive } from 'cmdk';
import type { ComponentProps, ReactNode } from 'react';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Root as VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { surfaceInteraction } from '@/components/ui/interaction';

function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn('flex h-full w-full flex-col overflow-hidden rounded-lg bg-surface-raised text-foreground', className)}
      {...props}
    />
  );
}

function CommandDialog({
  children,
  ...props
}: ComponentProps<typeof Dialog> & { children: ReactNode }) {
  const { t } = useTranslation('workspace');
  return (
    <Dialog {...props}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0 [&>button:last-child]:hidden">
        <VisuallyHidden>
          <DialogTitle>{t('command.title')}</DialogTitle>
        </VisuallyHidden>
        <Command className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-4 [&_[cmdk-input-wrapper]_svg]:w-4">
          {children as unknown as ComponentProps<typeof CommandPrimitive>['children']}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center border-b border-border px-3 transition-colors duration-[120ms] focus-within:border-ring" cmdk-input-wrapper="">
      <Search className="mr-2 size-4 shrink-0 text-muted-foreground" />
      <CommandPrimitive.Input
        className={cn(
          'flex h-12 w-full min-w-0 truncate bg-transparent py-3 text-[15px] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List className={cn('max-h-[min(24rem,60vh)] scroll-py-1 overflow-y-auto overflow-x-hidden p-1.5', className)} {...props} />;
}

function CommandEmpty({ className, ...props }: ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className={cn('py-6 text-center text-sm text-muted-foreground', className)} {...props} />;
}

function CommandGroup({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        'overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'relative flex min-h-9 min-w-0 cursor-pointer select-none items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-sm outline-none data-[disabled=true]:cursor-not-allowed data-[disabled=true]:pointer-events-none data-[selected=true]:bg-surface-subtle data-[selected=true]:text-foreground [&_svg]:shrink-0 data-[disabled=true]:opacity-50',
        surfaceInteraction,
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({ className, ...props }: ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
};
