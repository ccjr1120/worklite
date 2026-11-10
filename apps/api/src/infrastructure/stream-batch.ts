/** Coalesces adjacent chunks without delaying producers; flush is an ordering barrier. */
export class StreamBatch<T> {
  private pending?: T;
  private bytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private queue = Promise.resolve();
  constructor(
    private readonly write: (value: T) => Promise<void>,
    private readonly merge: (left: T, right: T) => T | undefined,
    private readonly size: (value: T) => number,
    private readonly delayMs = 50,
    private readonly maxBytes = 32_768,
  ) {}
  push(value: T): void {
    const merged = this.pending === undefined ? value : this.merge(this.pending, value);
    if (merged === undefined) this.enqueue();
    this.pending = merged ?? value;
    this.bytes = this.size(this.pending);
    if (this.bytes >= this.maxBytes) this.enqueue();
    else if (!this.timer) this.timer = setTimeout(() => this.enqueue(), this.delayMs);
  }
  private enqueue(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const value = this.pending;
    this.pending = undefined;
    this.bytes = 0;
    if (value !== undefined) {
      this.queue = this.queue.then(() => this.write(value));
      // flush still observes the error; timer callbacks never cause unhandled rejections.
      void this.queue.catch(() => undefined);
    }
  }
  async flush(): Promise<void> {
    this.enqueue();
    await this.queue;
  }
}
