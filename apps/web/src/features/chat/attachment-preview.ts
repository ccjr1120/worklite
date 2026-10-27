import { splitChatAttachmentImages } from '@worklite/contracts';

/**
 * One-line form of a message that may embed attachment images: the prose alone, or a count of the
 * images when the message was nothing but pictures. Keeps sidebar titles and queue rows from
 * printing raw `![…](/api/chat/attachments/att_…)` Markdown.
 */
export function messagePreview(content: string, imagesOnlyLabel: (count: number) => string): string {
  const { text, images } = splitChatAttachmentImages(content);
  if (text) return text;
  return images.length ? imagesOnlyLabel(images.length) : '';
}
