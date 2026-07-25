import { createHash } from "node:crypto";

import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

import type { JsonObject } from "./contracts.js";

export { EXTENSION_ID as MCP_APPS_EXTENSION_ID, RESOURCE_MIME_TYPE };

export interface McpAppResource {
  readonly buildHash: string;
  readonly uri: string;
  readonly mimeType: typeof RESOURCE_MIME_TYPE;
  readonly html: string;
  readonly htmlSha256: `sha256:${string}`;
  readonly canonicalAssets: readonly [
    {
      readonly path: "index.html";
      readonly bytes: number;
      readonly sha256: `sha256:${string}`;
    },
  ];
  readonly payloadManifestSha256: `sha256:${string}`;
  readonly listMeta: JsonObject;
  readonly readMeta: JsonObject;
}

const MCP_APP_CSP = {
  connectDomains: ["http://localhost:59941"],
  resourceDomains: ["http://localhost:59941"],
  frameDomains: [],
  baseUriDomains: [],
};

export function createMcpAppResource(html: string): McpAppResource {
  if (!html.trim()) {
    throw new Error("The MCP App HTML payload cannot be empty.");
  }

  const htmlDigest = createHash("sha256").update(html, "utf8").digest("hex");
  const htmlSha256 = `sha256:${htmlDigest}` as const;
  const canonicalAssets = [
    {
      path: "index.html",
      bytes: Buffer.byteLength(html, "utf8"),
      sha256: htmlSha256,
    },
  ] as const;
  const buildHash = createHash("sha256")
    .update(JSON.stringify(canonicalAssets), "utf8")
    .digest("hex");
  const uri = `ui://waptions/editor/v1/${buildHash}/index.html`;
  const uiMeta = {
    ui: {
      csp: MCP_APP_CSP,
      permissions: {},
      prefersBorder: true,
    },
  } satisfies JsonObject;

  return {
    buildHash,
    uri,
    mimeType: RESOURCE_MIME_TYPE,
    html,
    htmlSha256,
    canonicalAssets,
    payloadManifestSha256: `sha256:${buildHash}`,
    listMeta: uiMeta,
    readMeta: uiMeta,
  };
}

/**
 * This deterministic contract resource keeps tools/list and resources/read
 * valid before the P5B UI package is integrated. Production packaging must
 * inject the serious editor's immutable HTML payload and record the resulting
 * URI in the build manifest.
 */
export const CONTRACT_APP_RESOURCE = createMcpAppResource(
  [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>Waptions Editor Host</title>",
    "</head>",
    "<body>",
    '<main aria-live="polite">The Waptions editor UI package is not integrated in this runtime build.</main>',
    "</body>",
    "</html>",
  ].join(""),
);
