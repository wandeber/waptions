#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createMcpAppResource,
  type McpAppResource,
} from "../mcp/app-resource.js";
import {
  type ManagedCoordinatorAdapter,
} from "./coordinator-adapter.js";
import type { CoreSemanticSchemaBundle } from "../mcp/semantic-schema-adapter.js";
import {
  assertPrivateControlEndpoint,
  type CoordinatorControlEndpoint,
} from "./control-endpoint.js";
import { WaptionsMcpServer } from "./mcp-server.js";
import { BoundedStdioServerTransport } from "./bounded-stdio-transport.js";

interface AttachedRuntime {
  coordinator: ManagedCoordinatorAdapter;
  semanticSchemas: CoreSemanticSchemaBundle;
  controlEndpoint: CoordinatorControlEndpoint;
}

interface RuntimeModule {
  attachWaptionsRuntime?: () =>
    | AttachedRuntime
    | Promise<AttachedRuntime>;
}

interface RuntimeBuildManifest {
  appResource: {
    uri: string;
    mimeType: string;
    sha256: string;
    payloadManifestSha256: string;
    integrationPlaceholder: boolean;
  };
  schemaHashes: {
    coreSemantic: string | null;
  };
}

async function attachRuntime(): Promise<AttachedRuntime> {
  const modulePath = process.env.WAPTIONS_RUNTIME_ADAPTER_MODULE;
  if (!modulePath) {
    throw new Error(
      "WAPTIONS_RUNTIME_ADAPTER_MODULE is required; stdio must attach to the persistent coordinator.",
    );
  }

  const imported = (await import(
    pathToFileURL(resolve(modulePath)).href
  )) as RuntimeModule;
  if (typeof imported.attachWaptionsRuntime !== "function") {
    throw new Error(
      "WAPTIONS_RUNTIME_ADAPTER_MODULE must export attachWaptionsRuntime().",
    );
  }
  const attached = await imported.attachWaptionsRuntime();
  assertPrivateControlEndpoint(attached.controlEndpoint);
  return attached;
}

async function loadBuildManifest(): Promise<RuntimeBuildManifest> {
  return JSON.parse(
    await readFile(
      fileURLToPath(new URL("../build-manifest.json", import.meta.url)),
      "utf8",
    ),
  ) as RuntimeBuildManifest;
}

async function loadAppResource(
  manifest: RuntimeBuildManifest,
): Promise<McpAppResource> {
  const htmlPath = fileURLToPath(
    new URL("../mcp-app/index.html", import.meta.url),
  );
  const resource = createMcpAppResource(
    await readFile(resolve(htmlPath), "utf8"),
  );
  if (
    resource.uri !== manifest.appResource.uri ||
    resource.mimeType !== manifest.appResource.mimeType ||
    resource.htmlSha256 !== manifest.appResource.sha256 ||
    resource.payloadManifestSha256 !==
      manifest.appResource.payloadManifestSha256
  ) {
    throw new Error(
      "Packaged MCP App bytes do not match the verified build manifest.",
    );
  }
  return resource;
}

async function main(): Promise<void> {
  const manifest = await loadBuildManifest();
  const [attached, appResource] = await Promise.all([
    attachRuntime(),
    loadAppResource(manifest),
  ]);
  const allowPartial =
    process.env.NODE_ENV === "test" &&
    process.env.WAPTIONS_ALLOW_PARTIAL_RUNTIME === "1";
  if (
    (!allowPartial && manifest.appResource.integrationPlaceholder) ||
    (!allowPartial && manifest.schemaHashes.coreSemantic === null)
  ) {
    throw new Error(
      "The packaged runtime is missing its integrated MCP App or Core semantic schema hash.",
    );
  }
  if (
    manifest.schemaHashes.coreSemantic !== null &&
    attached.semanticSchemas.schemaSha256 !==
      manifest.schemaHashes.coreSemantic
  ) {
    throw new Error(
      "Attached Core semantic schema does not match the verified build manifest.",
    );
  }
  const runtime = new WaptionsMcpServer({
    coordinator: attached.coordinator,
    semanticSchemas: attached.semanticSchemas,
    appResource,
  });
  const transport = new BoundedStdioServerTransport(
    process.stdin,
    process.stdout,
  );
  let closing = false;

  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await runtime.close();
  };

  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
  process.stdin.once("end", () => {
    void close();
  });

  await runtime.connect(transport);
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown MCP server startup error.";
  process.stderr.write(`Waptions MCP server failed: ${message}\n`);
  process.exitCode = 1;
});
