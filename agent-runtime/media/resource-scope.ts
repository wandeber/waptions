import type { MediaDiagnosticsPort } from './ports';

type AsyncCleanup = () => Promise<void>;

export class AsyncResourceScope {
  private readonly cleanups: AsyncCleanup[] = [];
  private disposed = false;

  constructor(
    private readonly operationId: string,
    private readonly diagnostics: MediaDiagnosticsPort,
  ) {}

  defer(cleanup: AsyncCleanup): void {
    if (this.disposed) {
      throw new Error('Cannot register cleanup after resource scope disposal.');
    }
    let called = false;
    this.cleanups.push(async () => {
      if (called) {
        return;
      }
      called = true;
      await cleanup();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const failures: unknown[] = [];
    while (this.cleanups.length > 0) {
      const cleanup = this.cleanups.pop();
      if (!cleanup) {
        continue;
      }
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    this.diagnostics.record({
      name: 'media.resources.disposed',
      operationId: this.operationId,
      value: failures.length,
      attributes: {
        cleanupFailures: failures.length,
      },
    });
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more managed media resources failed to close.');
    }
  }
}
