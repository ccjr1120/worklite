import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Root as VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';

type ArchivedExecution = { id: string; label: string; archivedAt: string };

// A searchable modal selector rather than a view that replaces the transcript, so
// choosing a session never hides the conversation it is being chosen from.
function SessionSwitcher({ open, onOpenChange, archived, onResume, onRemove }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  archived: ArchivedExecution[];
  onResume: (item: ArchivedExecution) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation('assistant');
  const { locale } = useLocale();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 shadow-lg">
        <VisuallyHidden>
          <DialogTitle>{t('history.title')}</DialogTitle>
          <DialogDescription>{t('history.description')}</DialogDescription>
        </VisuallyHidden>
        <Command>
          <CommandInput placeholder={t('history.searchPlaceholder')} />
          <CommandList>
            {archived.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('history.empty')}</p>
            ) : (
              <>
                <CommandEmpty>{t('history.noMatch')}</CommandEmpty>
                {archived.map((item) => (
                  <CommandItem key={item.id} value={`${item.label} ${item.id}`} onSelect={() => onResume(item)} className="items-start">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.label}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{formatDateTime(new Date(item.archivedAt), locale)}</span>
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-compact"
                          aria-label={t('history.remove')}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => { event.stopPropagation(); onRemove(item.id); }}
                        >
                          <X className="size-4" aria-hidden="true" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('history.remove')}</TooltipContent>
                    </Tooltip>
                  </CommandItem>
                ))}
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

export { SessionSwitcher };
export type { ArchivedExecution };
