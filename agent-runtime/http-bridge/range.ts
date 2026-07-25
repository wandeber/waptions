import type { BridgeByteRange } from "./contracts.js";

export class InvalidByteRangeError extends Error {}

export function parseSingleByteRange(
  header: string | undefined,
  size: number,
): BridgeByteRange | undefined {
  if (header === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new InvalidByteRangeError("Resource size is invalid.");
  }
  if (size === 0 || header.includes(",")) {
    throw new InvalidByteRangeError("Range is not satisfiable.");
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) {
    throw new InvalidByteRangeError("Only one byte range is supported.");
  }

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (
      !Number.isSafeInteger(suffixLength) ||
      suffixLength <= 0
    ) {
      throw new InvalidByteRangeError("Suffix range is invalid.");
    }
    return {
      start: Math.max(0, size - suffixLength),
      endExclusive: size,
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    throw new InvalidByteRangeError("Range is not satisfiable.");
  }

  return {
    start,
    endExclusive: Math.min(size, requestedEnd + 1),
  };
}
