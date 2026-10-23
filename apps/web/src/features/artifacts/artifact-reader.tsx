import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { ImageOff } from 'lucide-react';
import type { ArtifactDetailView } from '@worklite/contracts';
import { ArtifactMarkdown } from './artifact-markdown';

function formattedJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function ArtifactReader({ artifact }: { artifact: ArtifactDetailView }) {
  const { t } = useTranslation('artifacts');
  const unresolvedImages = artifact.inlineImages.filter((image) => !image.url);

  const markdown = useMemo(() => {
    if (artifact.type !== 'markdown') return '';
    const content = artifact.content.trimStart();
    // The reading page has no separate title block; use the artifact name only
    // when the article did not supply its own heading.
    return /^#\s+/m.test(content) ? content : `# ${artifact.name}\n\n${content}`;
  }, [artifact.content, artifact.name, artifact.type]);

  const prettyJson = useMemo(
    () => (artifact.type === 'json' ? formattedJson(artifact.content) : ''),
    [artifact.content, artifact.type],
  );

  if (artifact.type === 'unsupported') {
    return <p className="text-[13px] text-muted-foreground">{t('details.unsupported')}</p>;
  }

  if (artifact.content === '') {
    return <p className="text-[13px] text-muted-foreground">{t('details.emptyContent')}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {unresolvedImages.length > 0 ? (
        <div role="status" className="flex flex-wrap items-start gap-2.5 rounded-xl border border-warning/40 bg-warning-subtle/60 px-4 py-3 text-[13px] leading-6">
          <ImageOff className="mt-1 size-4 shrink-0 text-warning" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-foreground">{t('reader.unresolvedImages')}</p>
          {artifact.runId ? (
            <Link to="/runs/$runId" params={{ runId: artifact.runId }} className="shrink-0 font-medium text-brand-text underline-offset-2 hover:underline">
              {t('reader.viewRun')}
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-xl border border-border bg-surface p-5 shadow-xs md:p-8">
        {artifact.type === 'markdown' ? (
          <ArtifactMarkdown content={markdown} images={artifact.inlineImages} />
        ) : (
          <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words font-mono text-[13px] leading-6">
            {artifact.type === 'json' ? prettyJson : artifact.content}
          </pre>
        )}
      </div>
    </div>
  );
}

export { ArtifactReader };
