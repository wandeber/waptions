import { describe, expect, it } from 'vitest';
import { LogicalSparseMediaByteSource } from './test-fixtures';

describe('logical-large media byte ranges', () => {
  it('reads high sparse ranges with source-size-independent resident chunks', async () => {
    const source = new LogicalSparseMediaByteSource({
      version: 1,
      byteLength: 16 * 1024 * 1024 * 1024 + 123,
      statIdentity: 'sparse-stat-v1',
    }, 4 * 1024 * 1024);
    const start = 9 * 1024 * 1024 * 1024;
    const endExclusive = start + 12 * 1024 * 1024;
    const reader = source.stream({ start, endExclusive }).getReader();
    let totalBytes = 0;
    let chunks = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      chunks += 1;
    }
    reader.releaseLock();
    await source.close();
    await source.close();

    expect(totalBytes).toBe(12 * 1024 * 1024);
    expect(chunks).toBe(3);
    expect(source.maximumResidentChunkBytes).toBe(4 * 1024 * 1024);
    expect(source.maximumResidentChunkBytes).toBeLessThan(source.identity.byteLength / 1000);
    expect(source.closeCount).toBe(1);
  });

  it('rejects one oversized range before allocating it', async () => {
    const source = new LogicalSparseMediaByteSource({
      version: 1,
      byteLength: 8 * 1024 * 1024 * 1024,
      statIdentity: 'sparse-stat-v1',
    }, 4 * 1024 * 1024);

    await expect(source.read({
      start: 0,
      endExclusive: 4 * 1024 * 1024 + 1,
    })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    expect(source.maximumResidentChunkBytes).toBe(0);
  });
});
