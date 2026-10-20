import { describe, expect, it } from 'vitest';
import { renderCanvasSticker, validateCanvasStickerConfig } from './canvas-sticker';

describe('validateCanvasStickerConfig', () => {
  const valid = { width: 256, height: 256, shape: 'roundedRect', backgroundColor: '#2563eb', cornerRadius: 16 };

  it('accepts a valid configuration', () => {
    expect(validateCanvasStickerConfig(valid)).toEqual(valid);
  });

  it('accepts every supported shape', () => {
    for (const shape of ['none', 'roundedRect', 'circle', 'ribbon']) {
      expect(() => validateCanvasStickerConfig({ ...valid, shape })).not.toThrow();
    }
  });

  it('rejects a non-object configuration', () => {
    expect(() => validateCanvasStickerConfig(null)).toThrow('Canvas Sticker node configuration must be an object.');
    expect(() => validateCanvasStickerConfig('x')).toThrow('Canvas Sticker node configuration must be an object.');
  });

  it('rejects width or height outside 64..2048', () => {
    expect(() => validateCanvasStickerConfig({ ...valid, width: 32 })).toThrow('width');
    expect(() => validateCanvasStickerConfig({ ...valid, width: 4096 })).toThrow('width');
    expect(() => validateCanvasStickerConfig({ ...valid, height: 1.5 })).toThrow('height');
  });

  it('rejects an unsupported shape', () => {
    expect(() => validateCanvasStickerConfig({ ...valid, shape: 'star' })).toThrow('shape');
  });

  it('rejects an invalid backgroundColor', () => {
    expect(() => validateCanvasStickerConfig({ ...valid, backgroundColor: 'blue' })).toThrow('backgroundColor');
  });

  it('accepts rgb/rgba and transparent colors', () => {
    expect(() => validateCanvasStickerConfig({ ...valid, backgroundColor: 'rgb(37, 99, 235)' })).not.toThrow();
    expect(() => validateCanvasStickerConfig({ ...valid, backgroundColor: 'rgba(37, 99, 235, 0.5)' })).not.toThrow();
    expect(() => validateCanvasStickerConfig({ ...valid, backgroundColor: 'transparent' })).not.toThrow();
  });

  it('rejects a negative cornerRadius', () => {
    expect(() => validateCanvasStickerConfig({ ...valid, cornerRadius: -1 })).toThrow('cornerRadius');
  });

  it('validates the optional text object', () => {
    expect(() => validateCanvasStickerConfig({ ...valid, text: 'nope' })).toThrow('text must be an object');
    expect(() => validateCanvasStickerConfig({ ...valid, text: { fontSize: 1000 } })).toThrow('fontSize');
    expect(() => validateCanvasStickerConfig({ ...valid, text: { fontFamily: 'cursive' } })).toThrow('fontFamily');
    expect(() => validateCanvasStickerConfig({ ...valid, text: { align: 'justify' } })).toThrow('align');
    expect(() => validateCanvasStickerConfig({ ...valid, text: { content: '封面标题', color: '#ffffff', fontSize: 48, fontFamily: 'serif', align: 'left' } })).not.toThrow();
  });
});

describe('renderCanvasSticker', () => {
  const config = validateCanvasStickerConfig({ width: 128, height: 128, shape: 'roundedRect', backgroundColor: '#2563eb', cornerRadius: 16, text: { color: '#ffffff', fontSize: 24 } });

  it('produces a valid PNG buffer', () => {
    const png = renderCanvasSticker(config, '封面');
    expect(png).toBeInstanceOf(Buffer);
    expect(png.length).toBeGreaterThan(0);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('is deterministic for identical configuration and text', () => {
    const first = renderCanvasSticker(config, 'hello');
    const second = renderCanvasSticker(config, 'hello');
    expect(first.equals(second)).toBe(true);
  });

  it('produces different output for different text', () => {
    const first = renderCanvasSticker(config, 'hello');
    const second = renderCanvasSticker(config, 'goodbye');
    expect(first.equals(second)).toBe(false);
  });

  it('produces different output for different shapes', () => {
    const circle = validateCanvasStickerConfig({ width: 128, height: 128, shape: 'circle', backgroundColor: '#2563eb' });
    const rect = validateCanvasStickerConfig({ width: 128, height: 128, shape: 'none', backgroundColor: '#2563eb' });
    expect(renderCanvasSticker(circle, undefined).equals(renderCanvasSticker(rect, undefined))).toBe(false);
  });

  it('renders without text when none is configured or supplied', () => {
    const noText = validateCanvasStickerConfig({ width: 128, height: 128, shape: 'none', backgroundColor: '#ffffff' });
    expect(() => renderCanvasSticker(noText, undefined)).not.toThrow();
  });

  it('falls back to configured text.content when no input text is supplied', () => {
    const withContent = validateCanvasStickerConfig({ width: 128, height: 128, shape: 'none', backgroundColor: '#ffffff', text: { content: '默认文字', color: '#000000' } });
    const withoutContent = validateCanvasStickerConfig({ width: 128, height: 128, shape: 'none', backgroundColor: '#ffffff' });
    expect(renderCanvasSticker(withContent, undefined).equals(renderCanvasSticker(withoutContent, undefined))).toBe(false);
  });
});
