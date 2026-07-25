import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createVerifiedMcpAppResource,
  RESOURCE_MIME_TYPE,
} from "./app-resource.js";

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

describe("verified MCP App resources", () => {
  it("preserves the package-authenticated content address", () => {
    const html = "<!doctype html><main>Waptions</main>";
    const buildHash = "a".repeat(64);
    const resource = createVerifiedMcpAppResource({
      html,
      buildHash,
      uri: `ui://waptions/editor/v1/${buildHash}/index.html`,
      mimeType: RESOURCE_MIME_TYPE,
      htmlSha256: sha256(html),
    });

    expect(resource.buildHash).toBe(buildHash);
    expect(resource.uri).toBe(
      `ui://waptions/editor/v1/${buildHash}/index.html`,
    );
    expect(resource.html).toBe(html);
    expect(resource.listMeta).toEqual({
      ui: {
        csp: {
          connectDomains: ["http://localhost:59941"],
          resourceDomains: ["http://localhost:59941"],
          frameDomains: [],
          baseUriDomains: [],
        },
        permissions: {},
        prefersBorder: true,
      },
    });
    expect(resource.readMeta).toEqual(resource.listMeta);
  });

  it("rejects identity and byte mismatches", () => {
    const html = "<!doctype html><main>Waptions</main>";
    const buildHash = "b".repeat(64);
    expect(() =>
      createVerifiedMcpAppResource({
        html,
        buildHash,
        uri: `ui://waptions/editor/v1/${"c".repeat(64)}/index.html`,
        mimeType: RESOURCE_MIME_TYPE,
        htmlSha256: sha256(html),
      }),
    ).toThrow("identity");
    expect(() =>
      createVerifiedMcpAppResource({
        html,
        buildHash,
        uri: `ui://waptions/editor/v1/${buildHash}/index.html`,
        mimeType: RESOURCE_MIME_TYPE,
        htmlSha256: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow("bytes");
  });
});
