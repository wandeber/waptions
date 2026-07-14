export interface AnimationFrameDriver {
  request(callback: FrameRequestCallback): number;
  cancel(requestId: number): void;
}

export interface ViewportRenderPublication {
  /** False after a hard invalidation or disposal; soft playback ticks keep it publishable. */
  isCurrent(): boolean;
}

export interface ViewportRenderInvalidation {
  /** Discards an in-flight result because its document, layout, or explicit seek is obsolete. */
  discardInFlight?: boolean;
}

const browserAnimationFrameDriver: AnimationFrameDriver = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (requestId) => cancelAnimationFrame(requestId),
};

/**
 * Serializes viewport renders while keeping a single pending invalidation.
 *
 * Video decoding can take longer than one display frame. Starting another decode while the first
 * one is in flight wastes work and makes late results harder to reject. This scheduler instead
 * coalesces invalidations, renders continuously only during playback, and becomes completely idle
 * once a paused frame has settled. Soft invalidations retain slow decoded frames so playback keeps
 * advancing visually; hard invalidations revoke results whose document or layout is obsolete.
 */
export class ViewportRenderScheduler {
  private readonly render: (publication: ViewportRenderPublication) => Promise<void> | void;
  private readonly driver: AnimationFrameDriver;
  private requestId: number | null = null;
  private isRendering = false;
  private hasPendingInvalidation = false;
  private isPlaying = false;
  private isDisposed = false;
  private publicationGeneration = 0;

  constructor(
    render: (publication: ViewportRenderPublication) => Promise<void> | void,
    driver: AnimationFrameDriver = browserAnimationFrameDriver,
  ) {
    this.render = render;
    this.driver = driver;
  }

  invalidate(options: ViewportRenderInvalidation = {}): void {
    if (this.isDisposed) return;
    if (options.discardInFlight) this.publicationGeneration += 1;
    this.hasPendingInvalidation = true;
    this.schedule();
  }

  setPlaying(isPlaying: boolean): void {
    if (this.isDisposed || this.isPlaying === isPlaying) return;
    this.isPlaying = isPlaying;
    // Both transitions need one exact boundary render. Playback then keeps scheduling frames,
    // while pause settles after this invalidation and leaves no background RAF behind.
    this.invalidate();
  }

  dispose(): void {
    this.isDisposed = true;
    this.publicationGeneration += 1;
    this.hasPendingInvalidation = false;
    if (this.requestId !== null) {
      this.driver.cancel(this.requestId);
      this.requestId = null;
    }
  }

  private schedule(): void {
    if (this.isDisposed || this.isRendering || this.requestId !== null) return;
    this.requestId = this.driver.request(() => {
      this.requestId = null;
      void this.runScheduledRender();
    });
  }

  private async runScheduledRender(): Promise<void> {
    if (this.isDisposed || (!this.hasPendingInvalidation && !this.isPlaying)) return;
    this.hasPendingInvalidation = false;
    this.isRendering = true;
    const generation = this.publicationGeneration;
    try {
      await this.render({
        isCurrent: () => !this.isDisposed && generation === this.publicationGeneration,
      });
    } finally {
      this.isRendering = false;
      if (this.isDisposed) return;
      if (this.isPlaying) this.hasPendingInvalidation = true;
      if (this.hasPendingInvalidation) this.schedule();
    }
  }
}
