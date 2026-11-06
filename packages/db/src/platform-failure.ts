import { createHash } from 'node:crypto';

export const PLATFORM_FAILURE_CONTRACT = 'platform-failure/v1';
export type PlatformFailure = {
  contract: typeof PLATFORM_FAILURE_CONTRACT;
  stage: 'admission' | 'input' | 'start' | 'execution' | 'api' | 'response';
  code: string;
  effect: 'not_started' | 'not_applied' | 'applied' | 'unknown';
  retry: 'correct_request' | 'inspect_before_retry';
  fields?: Array<{ path: string; rule: string }>;
  evidence?: unknown;
};

export function platformFailure(stage: PlatformFailure['stage'], code: string, effect: PlatformFailure['effect'], extra: Partial<PlatformFailure> = {}): PlatformFailure {
  return { ...extra, contract: PLATFORM_FAILURE_CONTRACT, stage, code, effect, retry: effect === 'not_started' || effect === 'not_applied' ? 'correct_request' : 'inspect_before_retry' };
}

export function platformContractHash(files: ReadonlyArray<{ path: string; content: string }>): string {
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

export function platformArgumentsHash(args: readonly string[]): string {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : value;
  const values = args.map((argument) => { try { return ordered(JSON.parse(argument)); } catch { return argument; } });
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
