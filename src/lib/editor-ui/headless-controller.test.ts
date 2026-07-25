import { describe, expect, it, vi } from 'vitest';
import { createEmptyEditorUiSnapshot } from './contracts';
import { HeadlessEditorUiController } from './headless-controller';

describe('HeadlessEditorUiController', () => {
  it('stays read-only while publishing deterministic job progress', () => {
    const initial = createEmptyEditorUiSnapshot({ sessionId: 'session' });
    initial.capabilities.canExport = true;
    const controller = new HeadlessEditorUiController('headless', initial);
    const listener = vi.fn();
    controller.subscribe(listener);

    const progressed = createEmptyEditorUiSnapshot({ sessionId: 'session' });
    progressed.jobs = [{
      id: 'export-job',
      kind: 'export',
      label: 'Export',
      state: 'running',
      progress: 0.5,
    }];
    controller.publish(progressed);

    expect(controller.getSnapshot().jobs[0]?.progress).toBe(0.5);
    expect(controller.getSnapshot().capabilities.canExport).toBe(false);
    expect(controller.getSnapshot().view.presentation).toBe('picture-in-picture');
    expect(listener).toHaveBeenCalledOnce();
  });
});
