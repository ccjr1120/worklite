import type { ElementType, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Shared single-line truncation for list rows and card summaries; detail views keep full text. */
const truncateLine = 'min-w-0 max-w-full truncate';

type TruncatedTextProps = {
  /** Text shown on one line; also the native tooltip unless `title` overrides it. */
  text: string;
  /** Full text for the tooltip when the visible text is already a shortened form. */
  title?: string;
  as?: ElementType;
  className?: string;
  role?: string;
  children?: ReactNode;
};

function TruncatedText({ text, title, as: Tag = 'span', className, role, children }: TruncatedTextProps) {
  return <Tag className={cn('block', truncateLine, className)} title={title ?? text} role={role}>{children ?? text}</Tag>;
}

export { TruncatedText };
