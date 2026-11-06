import { describe, expect, it } from 'vitest';
import {
  applyInlineImageUrls,
  findInlineImageReferences,
  planInlineImageUploads,
  validateGeneratedInlineImages,
} from './wechat-article-images';

function inline(payload: string, key?: string) {
  return { ...(key ? { key } : {}), b64Json: payload };
}

function image(payload: string, key?: string) {
  return {
    type: 'workflow_image',
    model: 'worklite/canvas-render',
    mediaType: 'image/png',
    ...(key ? { key } : {}),
    data: [{ b64Json: payload }],
  };
}

describe('findInlineImageReferences', () => {
  it('finds placeholders in article order and keeps alt text', () => {
    const markdown = '# Title\n\n![架构图](worklite-image:architecture)\n\ntext\n\n![second](worklite-image:2)';
    expect(findInlineImageReferences(markdown)).toEqual([
      { alt: '架构图', key: 'architecture', raw: '![架构图](worklite-image:architecture)' },
      { alt: 'second', key: '2', raw: '![second](worklite-image:2)' },
    ]);
  });

  it('ignores ordinary image links', () => {
    expect(findInlineImageReferences('![x](https://example.com/a.png)')).toEqual([]);
  });
});

describe('validateGeneratedInlineImages', () => {
  it('accepts generated image outputs and their optional keys', () => {
    expect(validateGeneratedInlineImages([image('AAA', 'cover')])).toEqual([{ key: 'cover', b64Json: 'AAA' }]);
    expect(validateGeneratedInlineImages(undefined)).toEqual([]);
  });

  it('splits one multi-image generation into ordered illustrations', () => {
    const generated = {
      type: 'workflow_image',
      model: 'codex/gpt-image-2',
      mediaType: 'image/png',
      key: 'ignored-for-multi',
      data: [{ b64Json: 'AAA' }, { b64Json: 'BBB' }],
    };
    expect(validateGeneratedInlineImages([generated])).toEqual([{ b64Json: 'AAA' }, { b64Json: 'BBB' }]);
  });

  it('rejects inputs that are not generated PNG images', () => {
    expect(() => validateGeneratedInlineImages([{ type: 'text', data: [] }])).toThrow('not a generated PNG image');
    expect(() => validateGeneratedInlineImages([{ type: 'workflow_image', mediaType: 'image/jpeg', data: [{}] }])).toThrow('not a generated PNG image');
    expect(() => validateGeneratedInlineImages([{ type: 'workflow_image', mediaType: 'image/png', data: [{}] }])).toThrow('missing PNG data');
  });
});

describe('planInlineImageUploads', () => {
  it('maps explicit keys and positional keys to distinct uploads', () => {
    const markdown = '![a](worklite-image:1)\n\n![b](worklite-image:second)\n\n![c](worklite-image:second)';
    const plan = planInlineImageUploads(markdown, [inline('AAA'), inline('BBB', 'second')]);
    expect(plan.uploads).toEqual([
      { uploadKey: 'position-1', b64Json: 'AAA' },
      { uploadKey: 'second', b64Json: 'BBB' },
    ]);
    expect([...plan.placeholderUploadKeys]).toEqual([['1', 'position-1'], ['second', 'second']]);
  });

  it('uploads one image once when an explicit key and its position both appear', () => {
    const markdown = '![a](worklite-image:figure-a)\n\n![b](worklite-image:1)';
    const plan = planInlineImageUploads(markdown, [inline('AAA', 'figure-a')]);
    expect(plan.uploads).toEqual([{ uploadKey: 'figure-a', b64Json: 'AAA' }]);
    expect([...plan.placeholderUploadKeys]).toEqual([['figure-a', 'figure-a'], ['1', 'figure-a']]);
  });

  it('lets an explicit numeric key win over a positional match', () => {
    const plan = planInlineImageUploads('![a](worklite-image:2)', [inline('AAA', '2'), inline('BBB')]);
    expect(plan.uploads).toEqual([{ uploadKey: '2', b64Json: 'AAA' }]);
  });

  it('rejects a placeholder with no matching image', () => {
    expect(() => planInlineImageUploads('![a](worklite-image:missing)', [inline('AAA', 'present')]))
      .toThrow('The article references inline image "missing"');
  });

  it('returns no uploads when the article has no placeholders', () => {
    expect(planInlineImageUploads('plain article', [inline('AAA')])).toEqual({ uploads: [], placeholderUploadKeys: new Map() });
  });
});

describe('applyInlineImageUrls', () => {
  it('rewrites every placeholder to the uploaded material URL', () => {
    const markdown = '![a](worklite-image:figure-a)\n\n![b](worklite-image:2)';
    const images = [inline('AAA', 'figure-a'), inline('BBB')];
    const plan = planInlineImageUploads(markdown, images);
    const rendered = applyInlineImageUrls(markdown, plan, new Map([
      ['figure-a', 'https://mmbiz.qpic.cn/mmbiz_png/a/0?wx_fmt=png'],
      ['position-2', 'https://mmbiz.qpic.cn/mmbiz_png/b/0?wx_fmt=png'],
    ]));
    expect(rendered).toBe('![a](https://mmbiz.qpic.cn/mmbiz_png/a/0?wx_fmt=png)\n\n![b](https://mmbiz.qpic.cn/mmbiz_png/b/0?wx_fmt=png)');
  });

  it('fails when an upload URL is missing', () => {
    const markdown = '![a](worklite-image:1)';
    const plan = planInlineImageUploads(markdown, [inline('AAA')]);
    expect(() => applyInlineImageUrls(markdown, plan, new Map())).toThrow('uploaded URL for inline image "1" is unavailable');
  });
});
