import { describe, expect, it, vi } from 'vitest';
import {
  ViewportRenderScheduler,
  type AnimationFrameDriver,
} from './viewport-render-scheduler';

const createFrameDriver = () => {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const driver: AnimationFrameDriver = {
    request: (callback) => {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    cancel: (id) => {
      callbacks.delete(id);
    },
  };
  const flushOne = () => {
    const entry = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) return false;
    callbacks.delete(entry[0]);
    entry[1](0);
    return true;
  };
  return { driver, callbacks, flushOne };
};

describe('ViewportRenderScheduler', () => {
  it('coalesces paused invalidations and becomes idle after the render settles', async () => {
    const frames = createFrameDriver();
    const render = vi.fn();
    const scheduler = new ViewportRenderScheduler(render, frames.driver);

    scheduler.invalidate();
    scheduler.invalidate();
    expect(frames.callbacks.size).toBe(1);

    frames.flushOne();
    await Promise.resolve();

    expect(render).toHaveBeenCalledTimes(1);
    expect(frames.callbacks.size).toBe(0);
  });

  it('keeps one follow-up invalidation when state changes during an async render', async () => {
    const frames = createFrameDriver();
    let releaseFirstRender!: () => void;
    const firstRender = new Promise<void>((resolve) => {
      releaseFirstRender = resolve;
    });
    const render = vi.fn()
      .mockReturnValueOnce(firstRender)
      .mockResolvedValue(undefined);
    const scheduler = new ViewportRenderScheduler(render, frames.driver);

    scheduler.invalidate();
    frames.flushOne();
    scheduler.invalidate();
    scheduler.invalidate();
    expect(frames.callbacks.size).toBe(0);

    releaseFirstRender();
    await firstRender;
    await Promise.resolve();
    expect(frames.callbacks.size).toBe(1);

    frames.flushOne();
    await Promise.resolve();
    expect(render).toHaveBeenCalledTimes(2);
    expect(frames.callbacks.size).toBe(0);
  });

  it('publishes a slow frame and coalesces repeated playback ticks into the latest follow-up', async () => {
    const frames = createFrameDriver();
    let requiredKey = 'red';
    const started: string[] = [];
    const published: string[] = [];
    const releaseRenders: Array<() => void> = [];
    const render = vi.fn(async (publication: { isCurrent(): boolean }) => {
      const key = requiredKey;
      started.push(key);
      await new Promise<void>((resolve) => releaseRenders.push(resolve));
      if (publication.isCurrent()) published.push(key);
    });
    const scheduler = new ViewportRenderScheduler(render, frames.driver);

    scheduler.invalidate();
    frames.flushOne();
    expect(started).toEqual(['red']);

    // A clock may advance multiple times during a cache-cold decode. These are soft requests:
    // the decoded red frame can still advance pixels, while only one blue follow-up is retained.
    requiredKey = 'blue';
    scheduler.invalidate();
    scheduler.invalidate();
    scheduler.invalidate();
    releaseRenders[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(published).toEqual(['red']);
    expect(frames.callbacks.size).toBe(1);

    frames.flushOne();
    expect(started).toEqual(['red', 'blue']);
    releaseRenders[1]();
    await Promise.resolve();
    await Promise.resolve();
    expect(published).toEqual(['red', 'blue']);
    expect(frames.callbacks.size).toBe(0);
  });

  it('rejects a slow result after a hard document invalidation', async () => {
    const frames = createFrameDriver();
    let requiredKey = 'red';
    const published: string[] = [];
    const releaseRenders: Array<() => void> = [];
    const render = vi.fn(async (publication: { isCurrent(): boolean }) => {
      const key = requiredKey;
      await new Promise<void>((resolve) => releaseRenders.push(resolve));
      if (publication.isCurrent()) published.push(key);
    });
    const scheduler = new ViewportRenderScheduler(render, frames.driver);

    scheduler.invalidate();
    frames.flushOne();
    requiredKey = 'blue';
    scheduler.invalidate({ discardInFlight: true });
    releaseRenders[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(published).toEqual([]);

    frames.flushOne();
    releaseRenders[1]();
    await Promise.resolve();
    await Promise.resolve();
    expect(published).toEqual(['blue']);
  });

  it('loops only while playing and renders one final paused boundary', async () => {
    const frames = createFrameDriver();
    const render = vi.fn();
    const scheduler = new ViewportRenderScheduler(render, frames.driver);

    scheduler.setPlaying(true);
    frames.flushOne();
    await Promise.resolve();
    expect(frames.callbacks.size).toBe(1);

    scheduler.setPlaying(false);
    frames.flushOne();
    await Promise.resolve();
    expect(render).toHaveBeenCalledTimes(2);
    expect(frames.callbacks.size).toBe(0);
  });

  it('cancels scheduled work when disposed', () => {
    const frames = createFrameDriver();
    const render = vi.fn();
    const scheduler = new ViewportRenderScheduler(render, frames.driver);

    scheduler.invalidate();
    scheduler.dispose();

    expect(frames.callbacks.size).toBe(0);
    expect(render).not.toHaveBeenCalled();
  });
});
