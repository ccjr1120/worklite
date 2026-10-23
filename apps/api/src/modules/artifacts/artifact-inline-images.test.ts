import { describe, expect, it } from 'vitest';
import { findArtifactImagePlaceholders, resolveArtifactInlineImages } from './artifact-inline-images';

describe('artifact inline images', () => {
  it('finds each placeholder once in document order', () => {
    const content = '# Title\n\n![架构图](worklite-image:fig-a)\n\n![架构图](worklite-image:fig-a)\n\n![第二张](worklite-image:2)';
    expect(findArtifactImagePlaceholders(content)).toEqual([
      { key: 'fig-a', alt: '架构图' },
      { key: '2', alt: '第二张' },
    ]);
  });

  it('prefers an explicit keyed URL from a run record', () => {
    const content = '![架构图](worklite-image:fig-a)';
    expect(resolveArtifactInlineImages(content, [{ inlineImageUrls: { 'fig-a': 'https://mmbiz.qpic.cn/a.png' } }])).toEqual([
      { key: 'fig-a', alt: '架构图', url: 'https://mmbiz.qpic.cn/a.png' },
    ]);
  });

  it('falls back to a resolved Markdown image with the same alt text', () => {
    const content = '![架构图](worklite-image:fig-a)';
    expect(resolveArtifactInlineImages(content, [{ article: '![架构图](https://mmbiz.qpic.cn/b.png)' }])).toEqual([
      { key: 'fig-a', alt: '架构图', url: 'https://mmbiz.qpic.cn/b.png' },
    ]);
  });

  it('leaves the URL null when the run only retained image summaries', () => {
    const content = '![架构图](worklite-image:fig-a)';
    expect(resolveArtifactInlineImages(content, [{ type: 'workflow_image_summary', key: 'fig-a', imageCount: 1 }])).toEqual([
      { key: 'fig-a', alt: '架构图', url: null },
    ]);
  });

  it('returns no entries for artifacts without placeholders', () => {
    expect(resolveArtifactInlineImages('# Plain article', [{ article: 'https://example.com' }])).toEqual([]);
  });
});
