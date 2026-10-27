/** Normalize a base64 PNG data URL only after validating its encoded image bytes. */
export function normalizeQrPngDataUrl(value: string | null): string | null {
  if (!value) return null;
  const match = /^data:image\/png(?:;[^,]*)?;base64,([\s\S]*)$/i.exec(value.trim());
  if (!match) return null;

  const encoded = match[1]!.replace(/\s+/g, '');
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength < 45 || bytes.byteLength > 32 * 1024 * 1024 || bytes.toString('base64') !== encoded) return null;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!bytes.subarray(0, 8).equals(signature) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 64 || height < 64 || width > 8192 || height > 8192) return null;

  let hasImageData = false;
  let hasEnd = false;
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.byteLength) return null;
    const chunkType = bytes.toString('ascii', offset + 4, offset + 8);
    if (chunkType === 'IDAT') hasImageData = true;
    offset = chunkEnd;
    if (chunkType === 'IEND') {
      if (length !== 0 || offset !== bytes.byteLength) return null;
      hasEnd = true;
      break;
    }
  }
  if (!hasImageData || !hasEnd) return null;
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

