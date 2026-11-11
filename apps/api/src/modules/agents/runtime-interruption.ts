// Give the native runtime time to stop its tools and persist the interrupted turn before
// disposing its transport. An unresponsive engine must still release the platform turn.
export async function settleRuntimeInterruption(stop: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(stop).catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
