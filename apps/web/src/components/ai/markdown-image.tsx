import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageOff } from 'lucide-react';

// Chat attachments are served by the API and expire with request logs.
const ATTACHMENT_PATH = /\/api\/chat\/attachments\/att_[A-Za-z0-9-]+$/;

type MarkdownImageProps = ComponentProps<'img'> & { node?: unknown };

/** Inline Markdown image; a failed attachment load shows the expired placeholder in its place. */
function MarkdownImage({ node: _node, src, alt, className: _className, ...props }: MarkdownImageProps) {
  const { t } = useTranslation('assistant');
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source = typeof src === 'string' ? src : '';
  if (!source) return null;

  if (failedSource === source) {
    // Only attachments are known to expire; any other broken image keeps its description as text.
    if (!ATTACHMENT_PATH.test(source.split(/[?#]/)[0] ?? '')) return alt ? <span className="text-muted-foreground">{alt}</span> : null;
    return (
      <span role="img" aria-label={alt ? `${alt}：${t('attachment.expired')}` : t('attachment.expired')} className="my-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-subtle px-2.5 py-1.5 text-xs text-muted-foreground">
        <ImageOff aria-hidden="true" className="size-3.5 shrink-0" />
        <span aria-hidden="true">{t('attachment.expired')}</span>
      </span>
    );
  }

  return (
    <img
      {...props}
      src={source}
      alt={alt ?? ''}
      loading="lazy"
      decoding="async"
      onError={() => setFailedSource(source)}
      className="my-2 block h-auto max-h-96 max-w-full rounded-md border border-border object-contain"
    />
  );
}

export { MarkdownImage };
