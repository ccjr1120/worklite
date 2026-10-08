const focusRing =
  'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25';

const focusRingInset =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50';

const controlInteraction =
  'transition-[border-color,background-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] hover:border-foreground/25 focus-visible:border-ring aria-invalid:border-danger aria-invalid:hover:border-danger aria-invalid:focus-visible:border-danger aria-invalid:focus-visible:ring-danger/20 disabled:hover:border-input';

const surfaceInteraction =
  'transition-[background-color,color,border-color,box-shadow,opacity] duration-[140ms] ease-[var(--ease-out)]';

// Single-line controls keep one line and truncate rather than wrap.
const singleLine = 'min-w-0 whitespace-nowrap';

export { controlInteraction, focusRing, focusRingInset, singleLine, surfaceInteraction };
