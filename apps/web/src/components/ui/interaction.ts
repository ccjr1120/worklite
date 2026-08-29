const focusRing =
  'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20';

const focusRingInset =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45';

const controlInteraction =
  'transition-[border-color,background-color,box-shadow] duration-[120ms] ease-out hover:border-foreground/25 focus-visible:border-ring aria-invalid:border-danger aria-invalid:hover:border-danger aria-invalid:focus-visible:border-danger aria-invalid:focus-visible:ring-danger/20 disabled:hover:border-input';

const surfaceInteraction =
  'transition-[background-color,color,border-color,box-shadow] duration-[120ms] ease-out';

export { controlInteraction, focusRing, focusRingInset, surfaceInteraction };
