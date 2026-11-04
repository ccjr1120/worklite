import { ConflictException } from '@nestjs/common';

/** A single engine invocation. Pause interrupts a turn; resume uses its saved engine session. */
export class SubAgentInstance {
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' = 'running';
  resumeId?: string;
  readonly done: Promise<unknown>;
  private controller = new AbortController();
  private pauseRequested = false;
  private wake?: () => void;
  private parked?: () => void;
  private pauseResult?: Promise<void>;

  constructor(
    readonly workspaceId: string,
    readonly executionId: string,
    readonly parentRunId: string,
    readonly agentId: string,
    readonly runId: string,
    parentSignal: AbortSignal,
    execute: (signal: AbortSignal) => Promise<unknown>,
    changed: (status: 'running' | 'paused') => void,
  ) {
    const cancel = () => { this.controller.abort(parentSignal.reason); this.wake?.(); };
    parentSignal.addEventListener('abort', cancel, { once: true });
    this.done = (async () => {
      try {
        while (true) {
          parentSignal.throwIfAborted();
          try {
            const result = await execute(AbortSignal.any([parentSignal, this.controller.signal]));
            this.status = 'completed';
            return result;
          } catch (error) {
            if (!this.pauseRequested || parentSignal.aborted) throw error;
            this.status = 'paused';
            // Install the wake-up before publishing the paused state.
            const resumed = new Promise<void>((resolve) => { this.wake = resolve; });
            changed('paused');
            this.parked?.();
            await resumed;
            parentSignal.throwIfAborted();
            this.pauseRequested = false;
            this.pauseResult = undefined;
            this.controller = new AbortController();
            this.status = 'running';
            changed('running');
          }
        }
      } catch (error) {
        this.status = parentSignal.aborted ? 'cancelled' : 'failed';
        throw error;
      } finally {
        this.parked?.();
        parentSignal.removeEventListener('abort', cancel);
      }
    })();
    // Background callers collect failures through done/wait, never an unhandled rejection.
    void this.done.catch(() => {});
  }

  async pause() {
    if (this.status === 'paused') return;
    if (this.status !== 'running') throw new ConflictException('This sub-Agent instance is no longer running.');
    if (!this.resumeId) throw new ConflictException('The engine has not saved a resumable session yet.');
    if (!this.pauseResult) {
      this.pauseResult = new Promise<void>((resolve) => { this.parked = resolve; });
      this.pauseRequested = true;
      this.controller.abort(new Error('Sub-Agent paused.'));
    }
    await this.pauseResult;
  }

  resume() {
    if (this.pauseRequested && this.status === 'running') throw new ConflictException('The sub-Agent is still pausing.');
    if (this.status !== 'paused') throw new ConflictException('Only a paused sub-Agent instance can resume.');
    this.status = 'running';
    this.wake?.();
  }
}
