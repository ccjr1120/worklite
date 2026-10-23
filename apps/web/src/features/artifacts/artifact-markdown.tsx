import type { ComponentProps } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageOff } from 'lucide-react';
import type { ArtifactInlineImageView } from '@worklite/contracts';
import { defaultUrlTransform, type Components, type UrlTransform } from 'streamdown';
import { MarkdownImage } from '@/components/ai/markdown-image';
import { StreamingMarkdown } from '@/components/ai/streaming-markdown';

const IMAGE_PLACEHOLDER = /!\[([^\]]*)\]\(\s*worklite-image:([^)\s]+)\s*\)/g;
const PLACEHOLDER_SCHEME = 'worklite-image:';

// React Markdown strips schemes it does not know; the placeholder must survive
// parsing so the custom image component can render an explicit explanation.
const sanitizeUrl = defaultUrlTransform as (url: string) => string;
const artifactUrlTransform: UrlTransform = (url) => (url.startsWith(PLACEHOLDER_SCHEME) ? url : sanitizeUrl(url));

type ArtifactMarkdownImageProps = ComponentProps<'img'> & { node?: unknown };

function ArtifactMarkdownImage({ node: _node, src, alt, ...props }: ArtifactMarkdownImageProps) {
  const { t } = useTranslation('artifacts');
  const source = typeof src === 'string' ? src : '';

  if (source.startsWith(PLACEHOLDER_SCHEME)) {
    const key = source.slice(PLACEHOLDER_SCHEME.length);
    const label = alt?.trim() || key;
    return (
      <span
        role="img"
        aria-label={`${label}：${t('reader.imagePlaceholder')}`}
        className="my-2 inline-flex max-w-full items-start gap-2.5 rounded-lg border border-dashed border-warning/50 bg-warning-subtle/60 px-3 py-2.5 text-left align-middle"
      >
        <ImageOff className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-foreground">{label}</span>
          <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">{source}</span>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">{t('reader.imagePlaceholder')}</span>
        </span>
      </span>
    );
  }

  return <MarkdownImage src={source} alt={alt} {...props} />;
}

const artifactComponents: Components = { img: ArtifactMarkdownImage };

/** Swap placeholders that the run resolved to a real URL; unresolved ones stay for the image component. */
export function applyResolvedArtifactImages(content: string, images: ArtifactInlineImageView[]): string {
  const urls = new Map(images.flatMap((image) => (image.url ? [[image.key, image.url] as const] : [])));
  if (urls.size === 0) return content;
  return content.replace(IMAGE_PLACEHOLDER, (raw, alt: string, key: string) => {
    const url = urls.get(key);
    return url ? `![${alt}](${url})` : raw;
  });
}

function ArtifactMarkdown({ content, images }: { content: string; images: ArtifactInlineImageView[] }) {
  const resolved = useMemo(() => applyResolvedArtifactImages(content, images), [content, images]);
  return (
    <StreamingMarkdown
      content={resolved}
      components={artifactComponents}
      urlTransform={artifactUrlTransform}
      className={[
        'text-[15px] leading-7',
        '[&_h1]:mt-0 [&_h1]:text-2xl [&_h1]:leading-9',
        '[&_h2]:text-xl [&_h2]:leading-8',
        '[&_h3]:text-base [&_h3]:leading-7',
        '[&_p]:my-3',
        '[&_blockquote]:my-4 [&_blockquote]:text-[15px]',
        '[&_img]:mx-auto',
      ].join(' ')}
    />
  );
}

export { ArtifactMarkdown };
