import { ModelGatewayError } from '@worklite/model-gateway';

export const TRANSIENT_PROVIDER_RETRY_DELAYS_MS: readonly number[] = [15_000, 45_000];

// Upstream outages and overload, not quota: an exhausted weekly quota (HTTP 429) does not
// recover within a minute and is reported immediately.
export function isTransientProviderFailure(error: unknown): boolean {
  return error instanceof ModelGatewayError
    && error.code === 'PROVIDER_REQUEST_FAILED'
    && typeof error.statusCode === 'number'
    && [500, 502, 503, 504, 529].includes(error.statusCode);
}

// The Gateway already retries a transient provider failure three times within about a second,
// which does not outlast an upstream outage of a minute (three HTTP 502s in a row failed a whole
// Run). While nothingRan() holds, the role has finished no model call and so has run no tool, and
// the invocation starts over after a longer wait instead of failing the Run.
export async function retryTransientProviderFailure<T>(options: {
  invoke: () => Promise<T>;
  nothingRan: () => boolean;
  signal: AbortSignal;
  onRetry: (detail: { retry: number; delayMs: number; reason: string }) => void;
  delaysMs?: readonly number[];
}): Promise<T> {
  const delays = options.delaysMs ?? TRANSIENT_PROVIDER_RETRY_DELAYS_MS;
  for (let retry = 0; ; retry += 1) {
    try {
      return await options.invoke();
    } catch (error) {
      const delayMs = delays[retry];
      if (delayMs === undefined || options.signal.aborted || !options.nothingRan() || !isTransientProviderFailure(error)) throw error;
      options.onRetry({ retry: retry + 1, delayMs, reason: error instanceof Error ? error.message : String(error) });
      await waitUnlessAborted(delayMs, options.signal);
      if (options.signal.aborted) throw error;
    }
  }
}

function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
