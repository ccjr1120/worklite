import { CollectionHeader, CollectionRow, CollectionTable } from '@/components/collection-table';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type CollectionLoadingProps = {
  columns: string[];
  label: string;
  rows?: number;
  headerClassName?: string;
  rowClassName?: string;
};

function CollectionLoading({ columns, label, rows = 5, headerClassName, rowClassName }: CollectionLoadingProps) {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      <CollectionTable>
        <CollectionHeader className={headerClassName} columns={columns} />
        {Array.from({ length: rows }, (_, rowIndex) => (
          <CollectionRow key={rowIndex} className={rowClassName}>
            {columns.map((column, columnIndex) => (
              <Skeleton
                key={`${column}-${columnIndex}`}
                className={cn('h-4 max-w-full', columnIndex === 0 ? 'w-4/5' : 'w-3/5')}
              />
            ))}
          </CollectionRow>
        ))}
      </CollectionTable>
    </div>
  );
}

export { CollectionLoading };
