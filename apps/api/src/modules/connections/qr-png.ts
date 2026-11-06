import { inflateSync } from 'node:zlib';

export type QrPngInspection = { dataUrl: string; width: number; height: number; darkRatio: number | null };

type PngHeader = { bitDepth: number; colorType: number; compression: number; filter: number; interlace: number };

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS_BY_COLOR_TYPE = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]);
const DARK_CHANNEL_CEILING = 140;

/**
 * Validate a base64 PNG data URL from its encoded image bytes and report how
 * much dark ink it carries. A structurally valid PNG can still be a blank
 * capture of a QR element that was mid-refresh or faded out by a CSS
 * transition, so callers gate on `darkRatio` before showing it as a QR code.
 */
export function inspectQrPng(value: string | null): QrPngInspection | null {
  if (!value) return null;
  const match = /^data:image\/png(?:;[^,]*)?;base64,([\s\S]*)$/i.exec(value.trim());
  if (!match) return null;

  const encoded = match[1]!.replace(/\s+/g, '');
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength < 45 || bytes.byteLength > 32 * 1024 * 1024 || bytes.toString('base64') !== encoded) return null;

  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 64 || height < 64 || width > 8192 || height > 8192) return null;
  const header: PngHeader = { bitDepth: bytes[24]!, colorType: bytes[25]!, compression: bytes[26]!, filter: bytes[27]!, interlace: bytes[28]! };

  const imageData: Buffer[] = [];
  let palette: Buffer | null = null;
  let paletteAlpha: Buffer | null = null;
  let hasEnd = false;
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.byteLength) return null;
    const chunkType = bytes.toString('ascii', offset + 4, offset + 8);
    if (chunkType === 'IDAT') imageData.push(bytes.subarray(offset + 8, offset + 8 + length));
    else if (chunkType === 'PLTE') palette = bytes.subarray(offset + 8, offset + 8 + length);
    else if (chunkType === 'tRNS') paletteAlpha = bytes.subarray(offset + 8, offset + 8 + length);
    offset = chunkEnd;
    if (chunkType === 'IEND') {
      if (length !== 0 || offset !== bytes.byteLength) return null;
      hasEnd = true;
      break;
    }
  }
  if (imageData.length === 0 || !hasEnd) return null;

  const darkRatio = darkPixelRatio(width, height, header, Buffer.concat(imageData), palette, paletteAlpha);
  return { dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, width, height, darkRatio };
}

/** Share of opaque dark pixels, or null when this PNG variant is not decoded here. */
function darkPixelRatio(width: number, height: number, header: PngHeader, imageData: Buffer, palette: Buffer | null, paletteAlpha: Buffer | null): number | null {
  const channels = CHANNELS_BY_COLOR_TYPE.get(header.colorType);
  if (!channels || header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) return null;
  if (header.bitDepth !== 8 && header.bitDepth !== 16) return null;
  if (header.colorType === 3 && (header.bitDepth !== 8 || !palette)) return null;

  let raw: Buffer;
  try {
    raw = inflateSync(imageData);
  } catch {
    return null;
  }

  const sampleBytes = header.bitDepth / 8;
  const pixelBytes = channels * sampleBytes;
  const stride = width * pixelBytes;
  if (raw.byteLength < height * (stride + 1)) return null;

  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  let darkPixels = 0;
  let cursor = 0;
  for (let row = 0; row < height; row += 1) {
    const filterType = raw[cursor]!;
    cursor += 1;
    raw.copy(current, 0, cursor, cursor + stride);
    cursor += stride;
    if (!unfilterScanline(filterType, current, previous, pixelBytes)) return null;
    for (let column = 0; column < width; column += 1) {
      const pixel = readPixel(current, column * pixelBytes, sampleBytes, header.colorType, palette, paletteAlpha);
      if (!pixel) return null;
      if (pixel.alpha > 0 && pixel.red < DARK_CHANNEL_CEILING && pixel.green < DARK_CHANNEL_CEILING && pixel.blue < DARK_CHANNEL_CEILING) darkPixels += 1;
    }
    current.copy(previous);
  }
  return darkPixels / (width * height);
}

function readPixel(scanline: Buffer, base: number, sampleBytes: number, colorType: number, palette: Buffer | null, paletteAlpha: Buffer | null) {
  // 16-bit samples are compared by their high byte; the extra precision cannot
  // change whether a pixel reads as dark ink.
  const sample = (index: number) => scanline[base + index * sampleBytes]!;
  if (colorType === 0) {
    const gray = sample(0);
    return { red: gray, green: gray, blue: gray, alpha: 255 };
  }
  if (colorType === 2) return { red: sample(0), green: sample(1), blue: sample(2), alpha: 255 };
  if (colorType === 3) {
    const index = scanline[base]!;
    const entry = index * 3;
    if (!palette || entry + 2 >= palette.byteLength) return null;
    return { red: palette[entry]!, green: palette[entry + 1]!, blue: palette[entry + 2]!, alpha: paletteAlpha && index < paletteAlpha.byteLength ? paletteAlpha[index]! : 255 };
  }
  if (colorType === 4) {
    const gray = sample(0);
    return { red: gray, green: gray, blue: gray, alpha: sample(1) };
  }
  return { red: sample(0), green: sample(1), blue: sample(2), alpha: sample(3) };
}

function unfilterScanline(filterType: number, current: Buffer, previous: Buffer, pixelBytes: number): boolean {
  if (filterType === 0) return true;
  if (filterType === 1) {
    for (let index = pixelBytes; index < current.byteLength; index += 1) current[index] = (current[index]! + current[index - pixelBytes]!) & 0xff;
    return true;
  }
  if (filterType === 2) {
    for (let index = 0; index < current.byteLength; index += 1) current[index] = (current[index]! + previous[index]!) & 0xff;
    return true;
  }
  if (filterType === 3) {
    for (let index = 0; index < current.byteLength; index += 1) {
      const left = index >= pixelBytes ? current[index - pixelBytes]! : 0;
      current[index] = (current[index]! + ((left + previous[index]!) >> 1)) & 0xff;
    }
    return true;
  }
  if (filterType === 4) {
    for (let index = 0; index < current.byteLength; index += 1) {
      const left = index >= pixelBytes ? current[index - pixelBytes]! : 0;
      const upperLeft = index >= pixelBytes ? previous[index - pixelBytes]! : 0;
      current[index] = (current[index]! + paethPredictor(left, previous[index]!, upperLeft)) & 0xff;
    }
    return true;
  }
  return false;
}

function paethPredictor(left: number, upper: number, upperLeft: number): number {
  const estimate = left + upper - upperLeft;
  const toLeft = Math.abs(estimate - left);
  const toUpper = Math.abs(estimate - upper);
  const toUpperLeft = Math.abs(estimate - upperLeft);
  if (toLeft <= toUpper && toLeft <= toUpperLeft) return left;
  return toUpper <= toUpperLeft ? upper : upperLeft;
}
