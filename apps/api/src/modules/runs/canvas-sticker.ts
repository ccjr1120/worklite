import { createCanvas } from '@napi-rs/canvas';

export type CanvasStickerShape = 'none' | 'roundedRect' | 'circle' | 'ribbon';

export type CanvasStickerTextConfig = {
  content?: string;
  color?: string;
  fontSize?: number;
  fontFamily?: 'sans-serif' | 'serif' | 'monospace';
  align?: 'left' | 'center' | 'right';
};

export type CanvasStickerConfig = {
  width: number;
  height: number;
  shape: CanvasStickerShape;
  backgroundColor: string;
  key?: string;
  cornerRadius?: number;
  text?: CanvasStickerTextConfig;
};

const CSS_COLOR_PATTERN = /^(#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\([0-9.,%\s]+\)|transparent)$/;

function assertColor(value: unknown, label: string): string {
  if (typeof value !== 'string' || !CSS_COLOR_PATTERN.test(value.trim())) throw new Error(`${label} must be a #hex, rgb(a)(), or transparent color.`);
  return value.trim();
}

export function validateCanvasStickerConfig(value: unknown): CanvasStickerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Canvas Sticker node configuration must be an object.');
  const config = value as Record<string, unknown>;
  if (typeof config.width !== 'number' || !Number.isInteger(config.width) || config.width < 64 || config.width > 2048) throw new Error('Canvas Sticker node width must be an integer between 64 and 2048.');
  if (typeof config.height !== 'number' || !Number.isInteger(config.height) || config.height < 64 || config.height > 2048) throw new Error('Canvas Sticker node height must be an integer between 64 and 2048.');
  if (config.shape !== 'none' && config.shape !== 'roundedRect' && config.shape !== 'circle' && config.shape !== 'ribbon') throw new Error('Canvas Sticker node shape must be none, roundedRect, circle, or ribbon.');
  const backgroundColor = assertColor(config.backgroundColor, 'Canvas Sticker node backgroundColor');
  let key: string | undefined;
  if (config.key !== undefined) {
    if (typeof config.key !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(config.key)) throw new Error('Canvas Sticker node key must be 1-64 characters of letters, digits, dots, underscores, or hyphens.');
    key = config.key;
  }
  let cornerRadius: number | undefined;
  if (config.cornerRadius !== undefined) {
    if (typeof config.cornerRadius !== 'number' || !Number.isInteger(config.cornerRadius) || config.cornerRadius < 0) throw new Error('Canvas Sticker node cornerRadius must be a non-negative integer.');
    cornerRadius = config.cornerRadius;
  }
  let text: CanvasStickerTextConfig | undefined;
  if (config.text !== undefined) {
    if (!config.text || typeof config.text !== 'object' || Array.isArray(config.text)) throw new Error('Canvas Sticker node text must be an object.');
    const rawText = config.text as Record<string, unknown>;
    if (rawText.content !== undefined && typeof rawText.content !== 'string') throw new Error('Canvas Sticker node text.content must be a string.');
    if (rawText.fontSize !== undefined && (typeof rawText.fontSize !== 'number' || !Number.isInteger(rawText.fontSize) || rawText.fontSize < 8 || rawText.fontSize > 400)) throw new Error('Canvas Sticker node text.fontSize must be an integer between 8 and 400.');
    if (rawText.fontFamily !== undefined && rawText.fontFamily !== 'sans-serif' && rawText.fontFamily !== 'serif' && rawText.fontFamily !== 'monospace') throw new Error('Canvas Sticker node text.fontFamily must be sans-serif, serif, or monospace.');
    if (rawText.align !== undefined && rawText.align !== 'left' && rawText.align !== 'center' && rawText.align !== 'right') throw new Error('Canvas Sticker node text.align must be left, center, or right.');
    text = {
      content: typeof rawText.content === 'string' ? rawText.content : undefined,
      color: rawText.color !== undefined ? assertColor(rawText.color, 'Canvas Sticker node text.color') : undefined,
      fontSize: typeof rawText.fontSize === 'number' ? rawText.fontSize : undefined,
      fontFamily: rawText.fontFamily as CanvasStickerTextConfig['fontFamily'],
      align: rawText.align as CanvasStickerTextConfig['align'],
    };
  }
  return { width: config.width, height: config.height, shape: config.shape, backgroundColor, key, cornerRadius, text };
}

function traceShapePath(ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>, config: CanvasStickerConfig): void {
  const { width, height, shape } = config;
  const radius = Math.min(config.cornerRadius ?? 0, Math.min(width, height) / 2);
  ctx.beginPath();
  if (shape === 'roundedRect') {
    ctx.roundRect(0, 0, width, height, radius);
  } else if (shape === 'circle') {
    const centerX = width / 2;
    const centerY = height / 2;
    const r = Math.min(width, height) / 2;
    ctx.ellipse(centerX, centerY, r, r, 0, 0, Math.PI * 2);
  } else if (shape === 'ribbon') {
    const notch = Math.min(width, height) * 0.12;
    ctx.moveTo(0, 0);
    ctx.lineTo(width, 0);
    ctx.lineTo(width - notch, height / 2);
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.lineTo(notch, height / 2);
    ctx.closePath();
  } else {
    ctx.rect(0, 0, width, height);
  }
}

/** Deterministic: identical config and text always produce byte-identical PNG output. */
export function renderCanvasSticker(config: CanvasStickerConfig, text: string | undefined): Buffer {
  const canvas = createCanvas(config.width, config.height);
  const ctx = canvas.getContext('2d');
  traceShapePath(ctx, config);
  ctx.fillStyle = config.backgroundColor;
  ctx.fill();

  const content = text ?? config.text?.content;
  if (content && content.trim()) {
    const fontSize = config.text?.fontSize ?? Math.round(Math.min(config.width, config.height) * 0.18);
    const fontFamily = config.text?.fontFamily ?? 'sans-serif';
    const align = config.text?.align ?? 'center';
    ctx.font = `${fontSize}px ${fontFamily}`;
    ctx.fillStyle = config.text?.color ?? '#000000';
    ctx.textBaseline = 'middle';
    ctx.textAlign = align;
    const x = align === 'left' ? config.width * 0.08 : align === 'right' ? config.width * 0.92 : config.width / 2;
    ctx.fillText(content, x, config.height / 2);
  }

  return canvas.toBuffer('image/png');
}
