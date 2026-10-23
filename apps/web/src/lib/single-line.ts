/**
 * Collapses free-form (possibly Markdown) text into one plain line for list and card summaries.
 * Uses the first meaningful line, drops block/inline Markdown markers and squeezes whitespace.
 * The full text belongs in the detail view; summaries only need a readable lead-in.
 */
export function toSingleLine(value: string | null | undefined): string {
  if (!value) return '';
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('```') || line.startsWith('~~~')) continue; // fence markers carry no content
    if (/^\|?[\s:|-]+\|?$/.test(line)) continue; // table separators and horizontal rules
    const text = line
      .replace(/^(?:#{1,6}\s+|>+\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|~~|`)/g, '')
      .replace(/^\|\s*|\s*\|$/g, '')
      .replace(/\s*\|\s*/g, ' · ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text;
  }
  return value.replace(/\s+/g, ' ').trim();
}
