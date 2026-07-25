import { describe, expect, it } from 'vitest';

import { ProcessDecodedMemoryBudget } from '../../diagnostics/decoded-memory-budget';
import {
    ProductionResourceBudget,
    ProductionRuntimeMetrics,
} from './resource-budget';
import { createProductionRuntimeAuthorityPorts } from './runtime-authority-ports';

describe('production runtime authority ports', () => {
    it('reports concurrent review and render bytes through one live budget', async () => {
        const bytes = new ProcessDecodedMemoryBudget(4_096);
        const budget = new ProductionResourceBudget(bytes);
        const ports = createProductionRuntimeAuthorityPorts({
            coordinator: {
                decodedMemoryBudget: bytes,
                jobs: { list: () => [] },
            } as never,
            mediaAssets: {} as never,
            media: {} as never,
            budget,
            metrics: new ProductionRuntimeMetrics(),
            transcription: {} as never,
        });

        const review = await budget.reserve({
            operationId: 'review-test',
            category: 'review-decode',
            bytes: 128,
        });
        const render = await budget.acquire('render-test', {
            'decoded-pixel-bytes': 256,
            'audio-mix-bytes': 64,
            'backend-processes': 1,
            'canvas-frames': 1,
            'export-jobs': 1,
            'video-decoder-sessions': 1,
        });

        expect(ports.diagnostics.resourceBudget.snapshot()).toEqual({
            currentBytes: 448,
            peakBytes: 448,
        });

        await review.release();
        render.release();
        expect(ports.diagnostics.resourceBudget.snapshot()).toEqual({
            currentBytes: 0,
            peakBytes: 448,
        });
    });
});
