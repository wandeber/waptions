import { toManagedMediaError } from './errors';
import type { DurableMediaJobPort, ManagedMediaJobUpdate } from './ports';

export class ManagedMediaJobLifecycle {
  constructor(private readonly jobs: DurableMediaJobPort) {}

  async run<T>(
    request: {
      readonly jobId: string;
      readonly queuedStage: string;
      readonly runningStage: string;
      readonly succeededStage: string;
      readonly execute: () => Promise<T>;
      readonly describeResult: (result: T) => Readonly<Record<string, unknown>>;
    },
    signal?: AbortSignal,
  ): Promise<T> {
    let sequence = 1;
    await this.publish({
      jobId: request.jobId,
      state: 'queued',
      stage: request.queuedStage,
      sequence,
      fraction: 0,
    }, signal);

    try {
      sequence += 1;
      await this.publish({
        jobId: request.jobId,
        state: 'running',
        stage: request.runningStage,
        sequence,
      }, signal);
      const result = await request.execute();
      sequence += 1;
      await this.publish({
        jobId: request.jobId,
        state: 'succeeded',
        stage: request.succeededStage,
        sequence,
        fraction: 1,
        result: request.describeResult(result),
      });
      return result;
    } catch (error) {
      const managed = toManagedMediaError(error);
      sequence += 1;
      await this.publish({
        jobId: request.jobId,
        state: managed.code === 'ABORTED' ? 'cancelled' : 'failed',
        stage: managed.code === 'ABORTED' ? 'cancelled' : 'failed',
        sequence,
        error: {
          code: managed.code,
          message: managed.message,
          retryable: managed.retryable,
        },
      }).catch(() => undefined);
      throw managed;
    }
  }

  private publish(update: ManagedMediaJobUpdate, signal?: AbortSignal): Promise<void> {
    return this.jobs.publish(update, signal);
  }
}
