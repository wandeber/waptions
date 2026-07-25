import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  BoundedStdioServerTransport,
  MAX_STDIO_MESSAGE_BYTES,
  StdioMessageTooLargeError,
} from "./bounded-stdio-transport.js";

describe("bounded stdio transport", () => {
  it("discards an oversized unterminated line before parsing and recovers at the next newline", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new BoundedStdioServerTransport(input, output);
    const errors: Error[] = [];
    const messages: unknown[] = [];
    transport.onerror = (error) => errors.push(error);
    transport.onmessage = (message) => messages.push(message);
    await transport.start();

    input.write(Buffer.alloc(MAX_STDIO_MESSAGE_BYTES + 1, 0x78));
    expect(errors).toEqual([expect.any(StdioMessageTooLargeError)]);
    expect(messages).toEqual([]);

    input.write(
      `\n${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      })}\n`,
    );
    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
    ]);
    expect(errors).toHaveLength(1);
    await transport.close();
  });
});
