import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

function CopyableId({ value, className }: { value: string; className?: string }) {
  const { t } = useTranslation('common');
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn('h-auto max-w-full gap-1 px-1 font-mono text-xs text-muted-foreground', className)}
          onClick={copy}
          aria-label={t('copy.value', { value })}
        >
          <span className="truncate">{value}</span>
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? t('copy.copied') : t('copy.identifier')}</TooltipContent>
    </Tooltip>
  );
}

export { CopyableId };
