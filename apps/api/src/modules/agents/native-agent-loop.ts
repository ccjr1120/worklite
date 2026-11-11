/** Execution mechanics only; business state and tool effects remain owned by the caller. */
export type NativeToolPolicy = { mode?: 'parallel' | 'sequential'; resourceKeys?: string[] };
export type NativeToolJob = {
  id: string;
  policy: NativeToolPolicy;
  execute(signal: AbortSignal, progress: (text: string) => Promise<void>): Promise<void>;
};
export type NativeToolHooks = {
  beforeTool?: (job: NativeToolJob) => Promise<void>;
  afterTool?: (job: NativeToolJob, error?: unknown) => Promise<void>;
  onProgress?: (job: NativeToolJob, text: string) => Promise<void>;
  finishBatch?: () => Promise<void>;
};

export class NativeAgentLoop {
  private readonly resourceTails = new Map<string, Promise<void>>();

  async modelStep<T>(generate: () => Promise<T>, hooks: {
    prepareRequest?: () => Promise<void>;
    afterResponse?: (response: T) => Promise<void>;
    finishStep?: (error?: unknown) => Promise<void>;
  } = {}): Promise<T> {
    let failure: unknown;
    try {
      await hooks.prepareRequest?.();
      const response = await generate();
      await hooks.afterResponse?.(response);
      return response;
    } catch (error) { failure = error; throw error; }
    finally { await hooks.finishStep?.(failure); }
  }

  async toolBatch(jobs: NativeToolJob[], signal: AbortSignal, hooks: NativeToolHooks = {}): Promise<void> {
    const execute = async (job: NativeToolJob) => {
      await this.withResources(job.policy.resourceKeys ?? [], signal, async () => {
        let failure: unknown;
        try {
          signal.throwIfAborted();
          await hooks.beforeTool?.(job);
          signal.throwIfAborted();
          await job.execute(signal, (text) => hooks.onProgress?.(job, text) ?? Promise.resolve());
        } catch (error) { failure = error; throw error; }
        finally { await hooks.afterTool?.(job, failure); }
      });
    };
    // A tool explicitly requiring sequential execution makes the whole batch sequential.
    if (jobs.some((job) => job.policy.mode === 'sequential')) {
      for (const job of jobs) await execute(job);
    } else {
      const results = await Promise.allSettled(jobs.map(execute));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
    signal.throwIfAborted();
    await hooks.finishBatch?.();
  }

  private async withResources(keys: string[], signal: AbortSignal, action: () => Promise<void>): Promise<void> {
    const unique = [...new Set(keys)].sort();
    const predecessors = Promise.all(unique.map((key) => this.resourceTails.get(key)));
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    // Retain predecessor ordering even when a queued operation is cancelled.
    const tail = predecessors.then(() => released);
    for (const key of unique) this.resourceTails.set(key, tail);
    void tail.then(() => {
      for (const key of unique) if (this.resourceTails.get(key) === tail) this.resourceTails.delete(key);
    });
    try {
      await abortableWait(predecessors, signal);
      signal.throwIfAborted();
      await action();
    } finally { release(); }
  }
}

function abortableWait(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Execution cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(() => { signal.removeEventListener('abort', abort); resolve(); }, (error) => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
