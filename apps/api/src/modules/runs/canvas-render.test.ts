import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { renderCanvasScript, validateCanvasRenderCode, validateCanvasRenderConfig } from './canvas-render';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function config(overrides: Record<string, unknown> = {}) {
  return validateCanvasRenderConfig({ width: 240, height: 160, ...overrides });
}

async function pixels(png: Buffer) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
}

describe('validateCanvasRenderConfig', () => {
  it('accepts a minimal configuration and applies documented defaults', () => {
    expect(validateCanvasRenderConfig({ width: 640, height: 360 })).toEqual({
      width: 640,
      height: 360,
      backgroundColor: '#ffffff',
      key: undefined,
      timeoutMs: 10_000,
      maxOutputBytes: 8 * 1024 * 1024,
    });
  });

  it('rejects dimensions outside the supported range and oversized canvases', () => {
    expect(() => validateCanvasRenderConfig(null)).toThrow('configuration must be an object');
    expect(() => validateCanvasRenderConfig({ width: 8, height: 100 })).toThrow('width');
    expect(() => validateCanvasRenderConfig({ width: 5000, height: 100 })).toThrow('width');
    expect(() => validateCanvasRenderConfig({ width: 4000, height: 4000 })).toThrow('canvas area');
    expect(() => validateCanvasRenderConfig({ width: 100.5, height: 100 })).toThrow('width');
  });

  it('validates the optional protection settings', () => {
    expect(() => validateCanvasRenderConfig({ width: 100, height: 100, backgroundColor: 'blue' })).toThrow('backgroundColor');
    expect(() => validateCanvasRenderConfig({ width: 100, height: 100, key: 'bad key' })).toThrow('key');
    expect(() => validateCanvasRenderConfig({ width: 100, height: 100, timeoutMs: 10 })).toThrow('timeoutMs');
    expect(() => validateCanvasRenderConfig({ width: 100, height: 100, maxOutputBytes: 10 })).toThrow('maxOutputBytes');
    expect(() => validateCanvasRenderConfig({ width: 100, height: 100, backgroundColor: 'rgb(1, 2, 3)', key: 'figure-1', timeoutMs: 500, maxOutputBytes: 2048 })).not.toThrow();
  });

  it('rejects an empty or oversized script', () => {
    expect(() => validateCanvasRenderCode('   ')).toThrow('non-empty code input');
    expect(() => validateCanvasRenderCode('```js\n```')).toThrow('non-empty code input');
    expect(() => validateCanvasRenderCode('x'.repeat(65_537))).toThrow('must not exceed');
    const code = 'ctx.fillRect(0, 0, 10, 10);';
    expect(validateCanvasRenderCode(code)).toBe(code);
  });

  it('strips one complete supported Markdown code fence before validation', () => {
    const code = 'ctx.fillRect(0, 0, 10, 10);\n';
    for (const openingFence of ['```', '```js', '```javascript']) {
      expect(validateCanvasRenderCode(openingFence + '\n' + code + '``` \t\n')).toBe(code);
    }
  });

  it('applies the script length limit after stripping the outer code fence', () => {
    const maximumScript = 'x'.repeat(65_535) + '\n';
    expect(validateCanvasRenderCode('```js\n' + maximumScript + '```')).toBe(maximumScript);
    expect(() => validateCanvasRenderCode('```js\n' + 'x'.repeat(65_536) + '\n```')).toThrow('must not exceed');
  });

  it('leaves incomplete or nested Markdown fences unchanged', () => {
    const incomplete = '```js\nctx.fillRect(0, 0, 10, 10);';
    const nested = '```js\nconst outer = 1;\n```python\nconst inner = 2;\n```\n';

    expect(validateCanvasRenderCode(incomplete)).toBe(incomplete);
    expect(validateCanvasRenderCode(nested)).toBe(nested);
  });

  it('takes the one compiling fenced block out of a reply that surrounds it with prose', () => {
    expect(validateCanvasRenderCode('Here is the script:\n```js\nctx.fillRect(0, 0, 10, 10);\n```\nIt draws a square.')).toBe('ctx.fillRect(0, 0, 10, 10);');
  });

  it('never cuts unfenced design notes away from a script', () => {
    // Prose and the first definition share a line, so any line cut would drop BLUE and still compile.
    const reply = '我设计了一张对比图。\nconst W=1080,H=720;\nbg fill #F6F7F9.\nFinal code below.const BLUE = \'#2F6FA8\';\nctx.fillStyle = BLUE;\nctx.fillRect(0, 0, 10, 10);';
    expect(validateCanvasRenderCode(reply)).toBe(reply);
  });

  it('keeps a reply with several compiling fenced blocks unchanged instead of guessing', () => {
    const reply = 'Option A:\n```js\nctx.fillRect(0, 0, 10, 10);\n```\nOption B:\n```js\nctx.fillRect(5, 5, 10, 10);\n```';
    expect(validateCanvasRenderCode(reply)).toBe(reply);
  });
});

describe('renderCanvasScript', () => {
  it('draws with the Canvas 2D API and returns a PNG at the configured size', async () => {
    const result = await renderCanvasScript(config(), `
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(10, 10, 50, 50);
      ctx.fillStyle = '#0000ff';
      ctx.fillRect(70, 10, 50, 50);
    `);
    expect(result.png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    const decoded = await pixels(result.png);
    expect(decoded.width).toBe(240);
    expect(decoded.height).toBe(160);
    const pixel = (x: number, y: number) => Array.from(decoded.data.slice((y * decoded.width + x) * 4, (y * decoded.width + x) * 4 + 4));
    expect(pixel(20, 20)).toEqual([255, 0, 0, 255]);
    expect(pixel(80, 20)).toEqual([0, 0, 255, 255]);
    expect(pixel(200, 140)).toEqual([255, 255, 255, 255]);
  });

  it('executes a script after its complete Markdown code fence is stripped', async () => {
    const code = validateCanvasRenderCode('```javascript\nctx.fillStyle = "#ff0000";\nctx.fillRect(0, 0, 20, 20);\n```');
    const result = await renderCanvasScript(config({ width: 32, height: 32 }), code);
    const decoded = await pixels(result.png);
    expect(Array.from(decoded.data.slice(0, 4))).toEqual([255, 0, 0, 255]);
  });

  it('applies the configured background before the script draws', async () => {
    const result = await renderCanvasScript(config({ backgroundColor: '#112233' }), '/* nothing to draw */');
    const decoded = await pixels(result.png);
    expect(Array.from(decoded.data.slice(0, 4))).toEqual([0x11, 0x22, 0x33, 255]);
  });

  it('is deterministic for identical code and configuration', async () => {
    const code = `
      ctx.fillStyle = '#2563eb';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#ffffff';
      ctx.font = '32px ' + fontFamily;
      ctx.fillText('确定性', 24, 80);
    `;
    const first = await renderCanvasScript(config(), code);
    const second = await renderCanvasScript(config(), code);
    expect(first.png.equals(second.png)).toBe(true);
    expect(first.fontFamily).toBe(second.fontFamily);
  });

  it('renders Chinese text with visible glyph pixels', async () => {
    const result = await renderCanvasScript(config({ width: 320, height: 120 }), `
      ctx.fillStyle = '#000000';
      ctx.font = '48px "' + fontFamily + '"';
      ctx.fillText('中文渲染', 10, 80);
    `);
    const decoded = await pixels(result.png);
    let darkPixels = 0;
    for (let index = 0; index < decoded.data.length; index += 4) {
      if (decoded.data[index]! < 32 && decoded.data[index + 1]! < 32 && decoded.data[index + 2]! < 32) darkPixels += 1;
    }
    expect(darkPixels).toBeGreaterThan(50);
  });

  it('draws distinct glyphs for different Chinese characters instead of a fallback box', async () => {
    const draw = (character: string) => renderCanvasScript(config({ width: 96, height: 96 }), `
      ctx.fillStyle = '#000000';
      ctx.font = '72px "' + fontFamily + '"';
      ctx.fillText(${JSON.stringify(character)}, 8, 78);
    `);
    const first = await draw('中');
    const second = await draw('龘');
    expect(first.png.equals(second.png)).toBe(false);
  });

  it('reports a script error with the node name', async () => {
    await expect(renderCanvasScript(config(), 'throw new Error("drawing exploded");')).rejects.toThrow('Canvas Render script failed: drawing exploded');
  });

  it('stops a runaway script at the configured timeout', async () => {
    const started = Date.now();
    await expect(renderCanvasScript(config({ timeoutMs: 200 }), 'while (true) {}')).rejects.toThrow('Canvas Render script timed out after 200 ms.');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('rejects output above maxOutputBytes', async () => {
    // A deterministic LCG keeps this test independent of Math.random.
    await expect(renderCanvasScript(config({ width: 400, height: 400, maxOutputBytes: 1024 }), `
      const data = ctx.createImageData(width, height);
      let seed = 123456789;
      for (let index = 0; index < data.data.length; index += 1) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        data.data[index] = seed % 256;
      }
      ctx.putImageData(data, 0, 0);
    `)).rejects.toThrow('exceeds the maxOutputBytes limit');
  });

  it('does not expose require, process, timers, network access, Date, or Math.random', async () => {
    await expect(renderCanvasScript(config({ width: 64, height: 64 }), `
      if (typeof require !== 'undefined') throw new Error('require leaked');
      if (typeof process !== 'undefined') throw new Error('process leaked');
      if (typeof fetch !== 'undefined') throw new Error('fetch leaked');
      if (typeof setTimeout !== 'undefined') throw new Error('setTimeout leaked');
      if (typeof Date !== 'undefined') throw new Error('Date leaked');
      if (typeof Math.random !== 'undefined') throw new Error('Math.random leaked');
      ctx.fillRect(0, 0, 10, 10);
    `)).resolves.toHaveProperty('png');
  });

  it('blocks host-constructor escapes through Canvas objects', async () => {
    await expect(renderCanvasScript(config({ width: 64, height: 64 }), `
      const reachable = ctx.constructor.constructor || ctx.fillRect.constructor;
      if (typeof reachable === 'function') {
        const processObject = reachable('return process')();
        if (processObject) throw new Error('escaped to process');
      }
      throw new Error('sandbox held');
    `)).rejects.toThrow('Canvas Render script failed: sandbox held');
  });
});
