import { describe, expectTypeOf, it } from 'vitest';
import type {
    TimelinePersistenceBinding,
    TimelineStore,
    TimelineVideoClip,
} from './timeline-store-types';
import { useTimelineStore } from './timeline-store';

describe('timeline store public contracts', () => {
    it('keeps the extracted public surface compatible with the Zustand store', () => {
        expectTypeOf(useTimelineStore.getState()).toMatchTypeOf<TimelineStore>();
        expectTypeOf<TimelineStore['videoClips']>().toEqualTypeOf<TimelineVideoClip[]>();
        expectTypeOf<TimelinePersistenceBinding['enqueue']>().returns.toBeVoid();
    });
});
