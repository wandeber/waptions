import { ManagedMediaError, throwIfAborted } from '../media/errors';

const encoder = new TextEncoder();

function encode(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function createJsonArrayArtifactStream(input: {
  readonly header: Readonly<Record<string, unknown>>;
  readonly arrayKey: string;
  readonly items: readonly unknown[];
  readonly signal?: AbortSignal;
}): ReadableStream<Uint8Array> {
  let index = -1;
  const headerEntries = Object.entries(input.header);
  const headerPrefix = headerEntries.length === 0
    ? '{'
    : `{${headerEntries
      .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
      .join(',')},`;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      throwIfAborted(input.signal);
      if (index === -1) {
        controller.enqueue(encoder.encode(`${headerPrefix}${JSON.stringify(input.arrayKey)}:[`));
        index = 0;
        return;
      }
      if (index < input.items.length) {
        const prefix = index === 0 ? '' : ',';
        const bytes = encode(input.items[index]);
        const chunk = new Uint8Array(prefix.length + bytes.byteLength);
        if (prefix) {
          chunk[0] = 44;
        }
        chunk.set(bytes, prefix.length);
        controller.enqueue(chunk);
        index += 1;
        return;
      }
      controller.enqueue(encoder.encode(']}\n'));
      controller.close();
    },
    cancel(reason) {
      if (input.signal?.aborted) {
        return;
      }
      throw new ManagedMediaError('ABORTED', 'Artifact stream was cancelled.', {
        retryable: true,
        cause: reason,
      });
    },
  });
}
