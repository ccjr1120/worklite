import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { Worker } from 'node:worker_threads';

export type CanvasRenderConfig = {
  width: number;
  height: number;
  backgroundColor: string;
  key?: string;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type CanvasRenderResult = {
  png: Buffer;
  width: number;
  height: number;
  fontFamily: string;
};

const CSS_COLOR_PATTERN = /^(#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\([0-9.,%\s]+\)|transparent)$/;
const IMAGE_KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_CANVAS_AREA = 8_000_000;
const DEFAULT_BACKGROUND_COLOR = '#ffffff';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_SCRIPT_LENGTH = 65_536;

function assertColor(value: unknown, label: string): string {
  if (typeof value !== 'string' || !CSS_COLOR_PATTERN.test(value.trim())) throw new Error(`${label} must be a #hex, rgb(a)(), or transparent color.`);
  return value.trim();
}

/** Validates the node configuration and fills in the documented defaults. */
export function validateCanvasRenderConfig(value: unknown): CanvasRenderConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Canvas Render node configuration must be an object.');
  const config = value as Record<string, unknown>;
  if (typeof config.width !== 'number' || !Number.isInteger(config.width) || config.width < 16 || config.width > 4096) throw new Error('Canvas Render node width must be an integer between 16 and 4096.');
  if (typeof config.height !== 'number' || !Number.isInteger(config.height) || config.height < 16 || config.height > 4096) throw new Error('Canvas Render node height must be an integer between 16 and 4096.');
  if (config.width * config.height > MAX_CANVAS_AREA) throw new Error(`Canvas Render node canvas area must not exceed ${MAX_CANVAS_AREA} pixels.`);
  const backgroundColor = config.backgroundColor === undefined
    ? DEFAULT_BACKGROUND_COLOR
    : assertColor(config.backgroundColor, 'Canvas Render node backgroundColor');
  let key: string | undefined;
  if (config.key !== undefined) {
    if (typeof config.key !== 'string' || !IMAGE_KEY_PATTERN.test(config.key)) throw new Error('Canvas Render node key must be 1-64 characters of letters, digits, dots, underscores, or hyphens.');
    key = config.key;
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (config.timeoutMs !== undefined) {
    if (typeof config.timeoutMs !== 'number' || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 60_000) throw new Error('Canvas Render node timeoutMs must be an integer between 100 and 60000.');
    timeoutMs = config.timeoutMs;
  }
  let maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES;
  if (config.maxOutputBytes !== undefined) {
    if (typeof config.maxOutputBytes !== 'number' || !Number.isInteger(config.maxOutputBytes) || config.maxOutputBytes < 1024 || config.maxOutputBytes > 33_554_432) throw new Error('Canvas Render node maxOutputBytes must be an integer between 1024 and 33554432.');
    maxOutputBytes = config.maxOutputBytes;
  }
  return { width: config.width, height: config.height, backgroundColor, key, timeoutMs, maxOutputBytes };
}

/** Removes one complete outer Markdown fence; malformed and nested fences remain untouched. */
function stripCompleteMarkdownCodeFence(value: string): string {
  const openingFence = /^```(?:js|javascript)?\r?\n/.exec(value);
  if (!openingFence) return value;

  const fencedContent = value.slice(openingFence[0].length);
  const closingFence = /(?:^|\r?\n)```[ \t]*\s*$/.exec(fencedContent);
  if (!closingFence) return value;

  const closingLineSeparatorLength = closingFence[0].startsWith('\r\n') ? 2 : closingFence[0].startsWith('\n') ? 1 : 0;
  const code = fencedContent.slice(0, closingFence.index + closingLineSeparatorLength);
  if (/^[ \t]*```/m.test(code)) return value;

  return code;
}

function compilesAsScriptBody(code: string): boolean {
  try {
    // Compiles only; the script runs later inside the sandboxed worker.
    new Script(`(function () {\n"use strict";\n${code}\n});`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recovers the script from a reply that wraps one fenced block in prose. Only a whole block
 * that compiles is taken; unfenced prose is never cut away, because a cut that drops a
 * definition or a drawing call can still compile and would render a wrong figure. Anything
 * else is returned unchanged so the render reports the model's real syntax error.
 */
function extractFencedScript(value: string): string {
  if (compilesAsScriptBody(value)) return value;
  const fenced = [...value.matchAll(/^```(?:js|javascript)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm)]
    .map((match) => match[1]!)
    .filter(compilesAsScriptBody);
  return fenced.length === 1 ? fenced[0]! : value;
}

export function validateCanvasRenderCode(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Canvas Render node requires a non-empty code input.');
  const code = extractFencedScript(stripCompleteMarkdownCodeFence(value));
  if (!code.trim()) throw new Error('Canvas Render node requires a non-empty code input.');
  if (code.length > MAX_SCRIPT_LENGTH) throw new Error(`Canvas Render node code must not exceed ${MAX_SCRIPT_LENGTH} characters.`);
  return code;
}

// The worker runs one script and exits. Isolating the render keeps a runaway
// script away from the API event loop, and the worker's resource limits plus
// the parent-side hard deadline bound memory and wall-clock time. Inside the
// worker the script runs in a vm context that exposes only the Canvas 2D
// surface; require/import, process, timers, network access, Date, and
// Math.random are unavailable. The host Function constructor is hidden while
// the script runs so a host object reached through ctx cannot synthesize code.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');

function findFontFamily(GlobalFonts) {
  const preferred = [
    'PingFang SC', 'Hiragino Sans GB', 'Heiti SC', 'STHeiti', 'Noto Sans CJK SC',
    'Noto Sans SC', 'Source Han Sans SC', 'Microsoft YaHei', 'WenQuanYi Micro Hei',
    'Arial Unicode MS',
  ];
  let families = [];
  try {
    families = GlobalFonts.families.map(function (entry) { return typeof entry === 'string' ? entry : entry.family; });
  } catch (error) {
    families = [];
  }
  for (const family of preferred) {
    if (families.includes(family)) return family;
  }
  return 'sans-serif';
}

function deterministicMath() {
  const copy = Object.create(null);
  for (const key of Object.getOwnPropertyNames(Math)) {
    if (key === 'random') continue;
    const value = Math[key];
    copy[key] = typeof value === 'function' ? value.bind(Math) : value;
  }
  return Object.freeze(copy);
}

function fail(error, timeout) {
  const message = error && typeof error.message === 'string' ? error.message : String(error);
  parentPort.postMessage({ ok: false, timeout: Boolean(timeout), error: message });
}

try {
  const { canvasModulePath, code, width, height, backgroundColor, timeoutMs, maxOutputBytes } = workerData;
  const canvasModule = require(canvasModulePath);
  const canvas = canvasModule.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, width, height);
  const fontFamily = findFontFamily(canvasModule.GlobalFonts);
  ctx.font = '48px "' + fontFamily + '"';

  const sandbox = {
    ctx: ctx,
    canvas: canvas,
    width: width,
    height: height,
    backgroundColor: backgroundColor,
    fontFamily: fontFamily,
    Math: deterministicMath(),
    Date: undefined,
    Intl: undefined,
    console: undefined,
    SharedArrayBuffer: undefined,
    Atomics: undefined,
    WebAssembly: undefined,
  };
  const context = vm.createContext(sandbox, {
    name: 'worklite-canvas-render',
    codeGeneration: { strings: false, wasm: false },
  });
  const script = new vm.Script('(function () {\n"use strict";\n' + code + '\n}).call(undefined);', {
    filename: 'worklite-canvas-script.js',
  });

  const savedFunctionConstructor = Function.prototype.constructor;
  Object.defineProperty(Function.prototype, 'constructor', { value: undefined, configurable: true, writable: true });
  try {
    script.runInContext(context, { timeout: timeoutMs, displayErrors: true });
  } finally {
    Object.defineProperty(Function.prototype, 'constructor', { value: savedFunctionConstructor, configurable: true, writable: true });
  }

  const png = canvas.toBuffer('image/png');
  if (png.length > maxOutputBytes) {
    fail('Canvas Render output PNG is ' + png.length + ' bytes, which exceeds the maxOutputBytes limit of ' + maxOutputBytes + '.', false);
  } else {
    parentPort.postMessage({ ok: true, png: new Uint8Array(png), width: width, height: height, fontFamily: fontFamily });
  }
} catch (error) {
  fail(error, error && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT');
}
`;

const workerRequire = createRequire(__filename);
let cachedCanvasModulePath: string | null = null;

function canvasModulePath(): string {
  if (!cachedCanvasModulePath) cachedCanvasModulePath = workerRequire.resolve('@napi-rs/canvas');
  return cachedCanvasModulePath;
}

/** Renders one Agent-authored Canvas 2D script in an isolated worker. */
export async function renderCanvasScript(
  config: CanvasRenderConfig,
  code: string,
  signal?: AbortSignal,
): Promise<CanvasRenderResult> {
  if (signal?.aborted) throw new Error('Canvas Render node was cancelled.');
  return new Promise<CanvasRenderResult>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        canvasModulePath: canvasModulePath(),
        code,
        width: config.width,
        height: config.height,
        backgroundColor: config.backgroundColor,
        timeoutMs: config.timeoutMs,
        maxOutputBytes: config.maxOutputBytes,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 96,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    });

    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      callback();
    };
    const onAbort = (): void => finish(() => reject(new Error('Canvas Render node was cancelled.')));
    // The worker enforces the script timeout itself; this deadline is the
    // backstop for a native call that never returns to JavaScript.
    const deadline = setTimeout(() => {
      finish(() => reject(new Error(`Canvas Render script timed out after ${config.timeoutMs} ms.`)));
    }, config.timeoutMs + 2_000);

    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (message: unknown) => {
      const result = message as { ok?: boolean; timeout?: boolean; error?: string; png?: Uint8Array; width?: number; height?: number; fontFamily?: string };
      if (result?.ok && result.png) {
        finish(() => resolve({
          png: Buffer.from(result.png!),
          width: result.width ?? config.width,
          height: result.height ?? config.height,
          fontFamily: result.fontFamily ?? 'sans-serif',
        }));
        return;
      }
      const detail = result?.error ?? 'Canvas Render worker returned no result.';
      finish(() => reject(new Error(result?.timeout
        ? `Canvas Render script timed out after ${config.timeoutMs} ms.`
        : detail.startsWith('Canvas Render ') ? detail : `Canvas Render script failed: ${detail}`)));
    });
    worker.once('error', (error) => {
      finish(() => reject(new Error(`Canvas Render worker failed: ${error instanceof Error ? error.message : String(error)}`)));
    });
    worker.once('exit', (exitCode) => {
      finish(() => reject(new Error(`Canvas Render worker exited unexpectedly with code ${exitCode}.`)));
    });
  });
}
