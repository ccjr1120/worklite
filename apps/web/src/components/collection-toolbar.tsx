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
  className?: string;
};

function CollectionToolbar({
  search,
  onSearchChange,
  placeholder,
  filters,
  chips,
  className,
}: CollectionToolbarProps) {
  const { t } = useTranslation('common');
  const searchLabel = placeholder ?? t('search.placeholder');

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
      {chips}
    </div>
  );
}

export { CollectionToolbar };
