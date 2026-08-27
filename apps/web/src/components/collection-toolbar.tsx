import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
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
  const { t } = useTranslation('common');
  const searchLabel = placeholder ?? t('search.placeholder');

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative max-w-sm flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={searchLabel}
              className="pl-8"
              aria-label={searchLabel}
            />
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
