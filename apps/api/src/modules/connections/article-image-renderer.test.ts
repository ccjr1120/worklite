import { describe, expect, it } from 'vitest';
import { findLayoutIssues, renderArticleImage, validateArticleImageInput, type LaidOutText } from './article-image-renderer';

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

function text(id: number, value: string, line: ReturnType<typeof box>, extra: Partial<LaidOutText> = {}): LaidOutText {
  return { id, text: value, blockId: id, blockText: value, fontSize: 28, lines: [line], container: line, clips: [], coveredLines: 0, ...extra };
}

describe('validateArticleImageInput', () => {
  it('rejects an image narrower than 1080px or shorter than 720px', () => {
    expect(() => validateArticleImageInput({ html: '<p>x</p>', width: 800 })).toThrow('width must be an integer from 1080');
    expect(() => validateArticleImageInput({ html: '<p>x</p>', height: 600 })).toThrow('height must be an integer from 720');
    expect(validateArticleImageInput({ html: '<p>x</p>' })).toEqual({ html: '<p>x</p>', width: 1080, height: 720 });
  });
});

describe('findLayoutIssues', () => {
  it('reports clean layout as having no issues', () => {
    expect(findLayoutIssues([text(0, '总参数', box(40, 40, 200, 80)), text(1, '激活参数', box(40, 120, 220, 160))], 1080, 720)).toEqual([]);
  });

  it('accepts glyphs that reach slightly past a tight line box', () => {
    expect(findLayoutIssues([text(0, '标题', box(64, 92, 700, 154), { fontSize: 44, container: box(64, 96, 1016, 151) })], 1080, 720)).toEqual([]);
  });

  it('detects text past the image edge, spilling from its box, overlapping, covered, duplicated and too small', () => {
    const issues = findLayoutIssues([
      text(0, '出界', box(1000, 40, 1120, 80)),
      text(1, '溢出', box(40, 100, 400, 140), { container: box(40, 100, 200, 140) }),
      text(2, '标签A', box(40, 200, 200, 240)),
      text(3, '标签B', box(60, 205, 220, 245)),
      text(4, '被遮住', box(500, 300, 600, 340), { coveredLines: 1 }),
      text(5, '重复', box(40, 400, 120, 440)),
      text(6, '重复', box(400, 400, 480, 440)),
      text(7, '小字', box(40, 600, 80, 614), { fontSize: 14 }),
    ], 1080, 720);
    expect(issues.map((issue) => issue.kind).sort()).toEqual(['clipped', 'covered', 'duplicate', 'overflow', 'overlap', 'small_text']);
  });
});

describe('renderArticleImage', () => {
  it('renders HTML without running scripts and reports real overlap', async () => {
    const result = await renderArticleImage({
      width: 1080,
      height: 720,
      html: '<div style="position:relative;width:1080px;height:720px"><div style="position:absolute;left:40px;top:40px;font-size:30px">标签一</div><div style="position:absolute;left:50px;top:45px;font-size:30px">标签二</div><script>document.body.innerHTML="ran"</script></div>',
    });
    expect(result.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(result.issues.map((issue) => issue.kind)).toContain('overlap');
  }, 60_000);
});
