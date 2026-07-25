import type { Readable, Writable } from "node:stream";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";

import { MAX_STRUCTURED_INPUT_BYTES } from "../mcp/constants.js";

export const MAX_STDIO_MESSAGE_BYTES =
  MAX_STRUCTURED_INPUT_BYTES + 128 * 1024;

export class StdioMessageTooLargeError extends Error {}

/**
 * Bounds each newline-delimited JSON-RPC message before JSON.parse. The SDK's
 * stock stdio transport accumulates an unterminated line without a ceiling,
 * which would let input bypass the semantic 512 KiB allocation guard.
 */
export class BoundedStdioServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private discardingOversizedLine = false;
  private started = false;
  private closed = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly maxMessageBytes = MAX_STDIO_MESSAGE_BYTES,
  ) {
    if (
      !Number.isSafeInteger(maxMessageBytes) ||
      maxMessageBytes < MAX_STRUCTURED_INPUT_BYTES
    ) {
      throw new Error("Stdio message byte limit is invalid.");
    }
  }

  private readonly onData = (inputChunk: Buffer | string) => {
    const chunk = Buffer.isBuffer(inputChunk)
      ? inputChunk
      : Buffer.from(inputChunk);
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.byteLength : newline;
      const segment = chunk.subarray(offset, end);

      if (!this.discardingOversizedLine && segment.byteLength > 0) {
        if (
          this.bufferedBytes + segment.byteLength >
          this.maxMessageBytes
        ) {
          this.chunks.length = 0;
          this.bufferedBytes = 0;
          this.discardingOversizedLine = true;
          this.onerror?.(
            new StdioMessageTooLargeError(
              `Stdio JSON-RPC message exceeds ${this.maxMessageBytes} bytes.`,
            ),
          );
        } else {
          this.chunks.push(segment);
          this.bufferedBytes += segment.byteLength;
        }
      }

      if (newline === -1) {
        break;
      }
      if (this.discardingOversizedLine) {
        this.discardingOversizedLine = false;
      } else {
        this.processBufferedLine();
      }
      this.chunks.length = 0;
      this.bufferedBytes = 0;
      offset = newline + 1;
    }
  };

  private readonly onInputError = (error: Error) => {
    this.onerror?.(error);
  };

  private processBufferedLine(): void {
    try {
      const line = Buffer.concat(this.chunks, this.bufferedBytes)
        .toString("utf8")
        .replace(/\r$/, "");
      const message = JSONRPCMessageSchema.parse(JSON.parse(line));
      this.onmessage?.(message);
    } catch (error) {
      this.onerror?.(
        error instanceof Error ? error : new Error("Invalid JSON-RPC input."),
      );
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("Bounded stdio transport is already started.");
    }
    this.started = true;
    this.input.on("data", this.onData);
    this.input.on("error", this.onInputError);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const serialized = `${JSON.stringify(message)}\n`;
    if (this.output.write(serialized)) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.output.once("drain", resolve);
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.input.off("data", this.onData);
    this.input.off("error", this.onInputError);
    if (this.input.listenerCount("data") === 0) {
      this.input.pause();
    }
    this.chunks.length = 0;
    this.bufferedBytes = 0;
    this.onclose?.();
  }
}
