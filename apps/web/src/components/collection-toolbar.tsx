import { useRef, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type CollectionToolbarProps = {
  search: string;
  onSearchChange: (value: string) => void;
  placeholder?: string;
  filters?: ReactNode;
  chips?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

function CollectionToolbar({
  search,
  onSearchChange,
  placeholder,
  filters,
  chips,
  actions,
  className,
}: CollectionToolbarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation('common');
  const searchLabel = placeholder ?? t('search.placeholder');

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative max-w-sm flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={searchLabel}
              onKeyDown={(event) => { if (event.key === 'Escape' && search) { event.preventDefault(); event.stopPropagation(); onSearchChange(''); } }}
              className="pl-8 pr-10"
              aria-label={searchLabel}
            />
            {search ? <button type="button" aria-label={t('actions.clearFilters')} onClick={() => { onSearchChange(''); inputRef.current?.focus(); }} className="wl-press absolute right-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-subtle hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="size-3.5" aria-hidden="true" /></button> : null}
          </div>
          {filters}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {chips}
    </div>
  );
}

export { CollectionToolbar };
