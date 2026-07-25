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

function createUiMeta(): JsonObject {
  return {
    ui: {
      csp: MCP_APP_CSP,
      permissions: {},
      prefersBorder: true,
    },
  };
}

export interface VerifiedMcpAppResourceInput {
  readonly html: string;
  readonly uri: string;
  readonly buildHash: string;
  readonly mimeType: string;
  readonly htmlSha256: `sha256:${string}`;
}

/**
 * Creates a resource from identity and bytes already authenticated by the
 * packaged runtime manifest. The content-addressed build hash intentionally is
 * not recomputed from the final wrapper because the packaging contract hashes
 * the URI-neutral wrapper plus every canonical payload file.
 */
export function createVerifiedMcpAppResource(
  input: VerifiedMcpAppResourceInput,
): McpAppResource {
  if (!input.html.trim()) {
    throw new Error("The MCP App HTML payload cannot be empty.");
  }
  if (
    !/^[a-f0-9]{64}$/.test(input.buildHash) ||
    input.uri !==
      `ui://waptions/editor/v1/${input.buildHash}/index.html` ||
    input.mimeType !== RESOURCE_MIME_TYPE ||
    !/^sha256:[a-f0-9]{64}$/.test(input.htmlSha256)
  ) {
    throw new Error("The verified MCP App identity is invalid.");
  }
  const htmlDigest = createHash("sha256")
    .update(input.html, "utf8")
    .digest("hex");
  if (`sha256:${htmlDigest}` !== input.htmlSha256) {
    throw new Error("The verified MCP App bytes do not match their digest.");
  }
  const canonicalAssets = [
    {
      path: "index.html",
      bytes: Buffer.byteLength(input.html, "utf8"),
      sha256: input.htmlSha256,
    },
  ] as const;
  const uiMeta = createUiMeta();
  return {
    buildHash: input.buildHash,
    uri: input.uri,
    mimeType: RESOURCE_MIME_TYPE,
    html: input.html,
    htmlSha256: input.htmlSha256,
    canonicalAssets,
    payloadManifestSha256: `sha256:${input.buildHash}`,
    listMeta: uiMeta,
    readMeta: uiMeta,
  };
}

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
  return createVerifiedMcpAppResource({
    html,
    buildHash,
    uri,
    mimeType: RESOURCE_MIME_TYPE,
    htmlSha256,
  });
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
