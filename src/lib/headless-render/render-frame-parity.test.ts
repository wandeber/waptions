import { describe, expect, it } from 'vitest';
import {
    createResolvedRenderPlan,
    renderResolvedPlanFrame,
} from '../render-plan';
import { createHeadlessRenderSnapshotFixture } from './headless-render.test-fixtures';

interface CanvasCall {
    method: string;
    args: unknown[];
}

function createRecordingContext(): {
    context: CanvasRenderingContext2D;
    calls: CanvasCall[];
    fillStyles: string[];
} {
    const calls: CanvasCall[] = [];
    const fillStyles: string[] = [];
    let fillStyle = '';
    const call = (method: string, ...args: unknown[]) => calls.push({ method, args });
    const context = {
        get fillStyle() {
            return fillStyle;
        },
        set fillStyle(value: string) {
            fillStyle = value;
            fillStyles.push(value);
        },
        strokeStyle: '',
        font: '',
        textAlign: 'center',
        textBaseline: 'middle',
        lineWidth: 0,
        lineJoin: 'round',
        fillRect: (...args: unknown[]) => call('fillRect', ...args),
        drawImage: (...args: unknown[]) => call('drawImage', ...args),
        save: () => call('save'),
        restore: () => call('restore'),
        translate: (...args: unknown[]) => call('translate', ...args),
        scale: (...args: unknown[]) => call('scale', ...args),
        measureText: (text: string) => ({ width: text.length * 10 }),
        beginPath: () => call('beginPath'),
        moveTo: (...args: unknown[]) => call('moveTo', ...args),
        lineTo: (...args: unknown[]) => call('lineTo', ...args),
        quadraticCurveTo: (...args: unknown[]) => call('quadraticCurveTo', ...args),
        fill: () => call('fill'),
        stroke: () => call('stroke'),
        strokeText: (...args: unknown[]) => call('strokeText', ...args),
        fillText: (...args: unknown[]) => call('fillText', ...args),
    } as unknown as CanvasRenderingContext2D;
    return { context, calls, fillStyles };
}

describe('resolved frame compositor parity', () => {
    it('paints black, applies shared contain geometry, then paints subtitles', () => {
        const plan = createResolvedRenderPlan(createHeadlessRenderSnapshotFixture());
        const { context, calls } = createRecordingContext();
        const image = {} as CanvasImageSource;

        renderResolvedPlanFrame(context, plan, 72, {
            sourceId: 'video-blue',
            image,
        });

        expect(calls[0]).toEqual({
            method: 'fillRect',
            args: [0, 0, 320, 180],
        });
        expect(calls.find((entry) => entry.method === 'drawImage')).toEqual({
            method: 'drawImage',
            args: [image, 109.375, 0, 101.25, 180],
        });
        expect(calls.find((entry) => entry.method === 'fillText')).toMatchObject({
            method: 'fillText',
            args: ['Visible', 160, 144],
        });
    });

    it('keeps subtitle and audio tails black without reusing a prior video frame', () => {
        const plan = createResolvedRenderPlan(createHeadlessRenderSnapshotFixture());
        const { context, calls } = createRecordingContext();

        renderResolvedPlanFrame(context, plan, 80, null);

        expect(calls[0]).toEqual({
            method: 'fillRect',
            args: [0, 0, 320, 180],
        });
        expect(calls.some((entry) => entry.method === 'drawImage')).toBe(false);
        expect(calls.find((entry) => entry.method === 'fillText')).toMatchObject({
            args: ['Visible', 160, 144],
        });
    });

    it('fails closed if a decoder returns a frame from the wrong immutable source', () => {
        const plan = createResolvedRenderPlan(createHeadlessRenderSnapshotFixture());
        const { context } = createRecordingContext();

        expect(() => renderResolvedPlanFrame(context, plan, 50, {
            sourceId: 'video-red',
            image: {} as CanvasImageSource,
        })).toThrow(/does not match/i);
    });

    it('paints the durable V4 background during gaps and legacy black by default', () => {
        const configured = createResolvedRenderPlan(createHeadlessRenderSnapshotFixture({
            renderBackground: { color: '#123456' },
        }));
        const configuredContext = createRecordingContext();
        renderResolvedPlanFrame(configuredContext.context, configured, 80, null);

        const legacy = createResolvedRenderPlan(createHeadlessRenderSnapshotFixture());
        const legacyContext = createRecordingContext();
        renderResolvedPlanFrame(legacyContext.context, legacy, 80, null);

        expect(configuredContext.fillStyles[0]).toBe('#123456');
        expect(legacyContext.fillStyles[0]).toBe('#000000');
    });
});
