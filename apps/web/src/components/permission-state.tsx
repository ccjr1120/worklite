import { ShieldAlert } from 'lucide-react';

type PermissionStateProps = {
  title: string;
  description: string;
};

function PermissionState({ title, description }: PermissionStateProps) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface px-6 py-6">
      <div className="flex items-center gap-2 text-foreground">
        <ShieldAlert className="size-4" aria-hidden="true" />
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <p className="text-[13px] text-muted-foreground">{description}</p>
    </div>
  );
}

export { PermissionState };
