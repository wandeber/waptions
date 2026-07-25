export const EDITORIAL_WAV_HEADER_BYTES = 44;
export const EDITORIAL_WAV_MAX_PART_BYTES = 4 * 1024 * 1024;
export const EDITORIAL_WAV_MAX_DATA_BYTES = 0xffff_ffff - 36;
export const EDITORIAL_WAV_MAX_SAMPLE_COUNT = Math.floor(EDITORIAL_WAV_MAX_DATA_BYTES / 2);

export class Pcm16WavPartAccumulator {
    private readonly partSampleCapacity = EDITORIAL_WAV_MAX_PART_BYTES / 2;
    private current = new Int16Array(this.partSampleCapacity);
    private currentLength = 0;
    private parts: Uint8Array[] = [];
    private sampleCount = 0;
    private released = false;

    append(values: ArrayLike<number>): void {
        if (this.released) throw new Error('Editorial PCM accumulator is released.');
        if (this.sampleCount + values.length > EDITORIAL_WAV_MAX_SAMPLE_COUNT) {
            throw new Error('Editorial PCM exceeds the RIFF/WAVE 32-bit payload limit.');
        }
        for (let offset = 0; offset < values.length;) {
            const count = Math.min(values.length - offset, this.current.length - this.currentLength);
            for (let index = 0; index < count; index += 1) {
                this.current[this.currentLength + index] = values[offset + index];
            }
            this.currentLength += count;
            this.sampleCount += count;
            offset += count;
            if (this.currentLength === this.current.length) this.flush();
        }
    }

    finish(expectedSampleCount: number): Blob {
        if (this.released) throw new Error('Editorial PCM accumulator is released.');
        if (this.sampleCount !== expectedSampleCount) {
            throw new Error('Editorial PCM output count does not match its declared WAV size.');
        }
        this.flush();
        const blob = new Blob(
            [createPcm16WavHeader(expectedSampleCount), ...this.parts],
            { type: 'audio/wav' },
        );
        // Drop local references after Blob construction. The Blob owns immutable snapshots of
        // each bounded part; no second complete ArrayBuffer is constructed.
        this.release();
        return blob;
    }

    release(): void {
        this.released = true;
        this.current = new Int16Array(0);
        this.currentLength = 0;
        this.parts = [];
    }

    private flush(): void {
        if (this.currentLength === 0) return;
        const bytes = new Uint8Array(this.currentLength * 2);
        const view = new DataView(bytes.buffer);
        for (let index = 0; index < this.currentLength; index += 1) {
            view.setInt16(index * 2, this.current[index], true);
        }
        this.parts.push(bytes);
        this.current = new Int16Array(this.partSampleCapacity);
        this.currentLength = 0;
    }
}

export function createPcm16WavHeader(sampleCount: number): Uint8Array {
    if (!Number.isSafeInteger(sampleCount) || sampleCount < 0
        || sampleCount > EDITORIAL_WAV_MAX_SAMPLE_COUNT) {
        throw new Error('Editorial WAV sample count is outside the RIFF limit.');
    }
    const dataBytes = sampleCount * 2;
    const header = new Uint8Array(EDITORIAL_WAV_HEADER_BYTES);
    const view = new DataView(header.buffer);
    writeAscii(header, 0, 'RIFF');
    view.setUint32(4, dataBytes + 36, true);
    writeAscii(header, 8, 'WAVE');
    writeAscii(header, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16_000, true);
    view.setUint32(28, 32_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(header, 36, 'data');
    view.setUint32(40, dataBytes, true);
    return header;
}

/** Test/fixture helper that still enforces the same bounded-part and exact-count contract. */
export function createPcm16WavBlob(
    parts: readonly Int16Array[],
    sampleCount: number,
): Blob {
    const accumulator = new Pcm16WavPartAccumulator();
    for (const part of parts) accumulator.append(part);
    return accumulator.finish(sampleCount);
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
    for (let index = 0; index < value.length; index += 1) {
        target[offset + index] = value.charCodeAt(index);
    }
}
