import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageOff } from 'lucide-react';
import { DialogTrigger } from '@radix-ui/react-dialog';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { focusRing } from '@/components/ui/interaction';

// Chat attachments are served by the API and expire with request logs.
const ATTACHMENT_PATH = /\/api\/chat\/attachments\/att_[A-Za-z0-9-]+$/;

type MarkdownImageProps = ComponentProps<'img'> & { node?: unknown };

/** Inline Markdown image; a failed attachment load shows the expired placeholder in its place. */
function MarkdownImage({ node: _node, src, alt, className: _className, ...props }: MarkdownImageProps) {
  const { t } = useTranslation('assistant');
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [previewSource, setPreviewSource] = useState<string | null>(null);
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
    <Dialog open={previewSource === source} onOpenChange={(open) => setPreviewSource(open ? source : null)}>
      <DialogTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          aria-label={alt ? `${t('attachment.preview')}：${alt}` : t('attachment.preview')}
          className={`my-2 block max-w-full cursor-zoom-in rounded-md ${focusRing}`}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.click();
            }
          }}
          onClick={(event) => {
            // Markdown images can be wrapped in links. Preview without navigating away.
            event.preventDefault();
            event.stopPropagation();
            setPreviewSource(source);
          }}
        >
          <img
            {...props}
            src={source}
            alt={alt ?? ''}
            loading="lazy"
            decoding="async"
            onError={() => setFailedSource(source)}
            className="block h-auto max-h-96 max-w-full rounded-md border border-border object-contain"
          />
        </span>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="w-fit max-w-[calc(100vw-32px)] gap-0 p-12"
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
      >
        <DialogTitle className="sr-only">{alt || t('attachment.preview')}</DialogTitle>
        <img
          src={source}
          alt={alt ?? ''}
          referrerPolicy={props.referrerPolicy}
          crossOrigin={props.crossOrigin}
          decoding="async"
          onError={() => setFailedSource(source)}
          className="block h-auto max-h-[calc(100dvh-128px)] max-w-full object-contain"
        />
      </DialogContent>
    </Dialog>
  );
}

export { MarkdownImage };
