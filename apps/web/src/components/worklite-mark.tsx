function WorkLiteMark({ className }: { className?: string }) {
  return <img src="/brand/worklite-logo.png" className={`${className ?? 'size-5'} worklite-mark`} alt="" aria-hidden="true" draggable="false" />;
}

export { WorkLiteMark };
